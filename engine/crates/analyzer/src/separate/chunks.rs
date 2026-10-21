#[derive(Debug, Clone, Copy)]
pub struct ChunkPlan {
    pub total: usize,
    pub segment: usize,
    pub stride: usize,
}

impl ChunkPlan {
    pub fn new(total: usize, segment: usize, overlap: f64) -> Self {
        let stride = (((1.0 - overlap) * segment as f64) as usize).max(1);
        Self { total, segment, stride }
    }

    pub fn offsets(&self) -> impl Iterator<Item = usize> {
        (0..self.total).step_by(self.stride)
    }

    pub fn count(&self) -> usize {
        self.total.div_ceil(self.stride)
    }

    pub fn chunk_len(&self, offset: usize) -> usize {
        self.segment.min(self.total - offset)
    }

    pub fn final_until(&self, offset: usize) -> usize {
        (offset + self.stride).min(self.total)
    }
}

pub fn transition_weight(segment: usize) -> Vec<f32> {
    let half = segment / 2;
    let mut w: Vec<f32> = (1..=half).map(|v| v as f32).collect();
    w.extend((1..=segment - half).rev().map(|v| v as f32));
    let max = w.iter().copied().fold(0f32, f32::max);
    for v in &mut w {
        *v /= max;
    }
    w
}

pub fn padded_chunk(src: &[f32], offset: usize, length: usize, out: &mut [f32]) {
    let target = out.len();
    debug_assert!(length <= target);
    let start = offset as isize - ((target - length) / 2) as isize;
    for (k, o) in out.iter_mut().enumerate() {
        let j = start + k as isize;
        *o = if j >= 0 && (j as usize) < src.len() { src[j as usize] } else { 0.0 };
    }
}

pub fn center_trim_start(target: usize, length: usize) -> usize {
    (target - length) / 2
}

pub struct OverlapAdd {
    acc: Vec<Vec<f32>>,
    wsum: Vec<f32>,
    stride: usize,
}

impl OverlapAdd {
    pub fn new(channels: usize, plan: &ChunkPlan) -> Self {
        Self { acc: vec![vec![0f32; plan.segment]; channels], wsum: vec![0f32; plan.segment], stride: plan.stride }
    }

    pub fn add(&mut self, chunk: &[&[f32]], weight: &[f32]) {
        let len = chunk[0].len();
        for (acc, src) in self.acc.iter_mut().zip(chunk) {
            for ((a, s), w) in acc[..len].iter_mut().zip(*src).zip(weight) {
                *a += w * s;
            }
        }
        for (ws, w) in self.wsum[..len].iter_mut().zip(weight) {
            *ws += w;
        }
    }

    pub fn take(&mut self, n: usize, out: &mut [Vec<f32>]) {
        for (acc, o) in self.acc.iter().zip(out.iter_mut()) {
            o.clear();
            o.extend(acc[..n].iter().zip(&self.wsum[..n]).map(|(a, w)| if *w > 0.0 { a / w } else { 0.0 }));
        }
        let keep = self.wsum.len() - self.stride;
        for acc in &mut self.acc {
            acc.copy_within(self.stride.., 0);
            acc[keep..].fill(0.0);
        }
        self.wsum.copy_within(self.stride.., 0);
        self.wsum[keep..].fill(0.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_matches_demucs() {
        let p = ChunkPlan::new(1_000_000, 343_980, 0.25);
        assert_eq!(p.stride, 257_985);
        let offs: Vec<usize> = p.offsets().collect();
        assert_eq!(offs, vec![0, 257_985, 515_970, 773_955]);
        assert_eq!(p.count(), 4);
        assert_eq!(p.chunk_len(773_955), 226_045);
        assert_eq!(p.final_until(0), 257_985);
        assert_eq!(p.final_until(773_955), 1_000_000);
        let short = ChunkPlan::new(1000, 343_980, 0.25);
        assert_eq!(short.offsets().collect::<Vec<_>>(), vec![0]);
        assert_eq!(short.chunk_len(0), 1000);
    }

    #[test]
    fn weight_is_demucs_triangle() {
        let w = transition_weight(10);
        let expect = [1., 2., 3., 4., 5., 5., 4., 3., 2., 1.].map(|v: f32| v / 5.0);
        assert_eq!(w, expect);
        let w = transition_weight(7);
        let expect = [1., 2., 3., 4., 3., 2., 1.].map(|v: f32| v / 4.0);
        assert_eq!(w, expect);
    }

    #[test]
    fn padded_chunk_centres_with_neighbours() {
        let src: Vec<f32> = (1..=10).map(|v| v as f32).collect();
        let mut out = [0f32; 6];
        padded_chunk(&src, 8, 2, &mut out);
        assert_eq!(out, [7., 8., 9., 10., 0., 0.]);
        padded_chunk(&src, 0, 2, &mut out);
        assert_eq!(out, [0., 0., 1., 2., 3., 4.]);
        assert_eq!(center_trim_start(6, 2), 2);
        let mut full = [0f32; 4];
        padded_chunk(&src, 3, 4, &mut full);
        assert_eq!(full, [4., 5., 6., 7.]);
    }

    #[test]
    fn overlap_add_reconstructs_identity() {
        for total in [5usize, 99, 100, 101, 250, 333, 1000] {
            let src: Vec<f32> = (0..total).map(|i| (i as f32 * 0.37).sin() + 0.1 * i as f32).collect();
            let plan = ChunkPlan::new(total, 100, 0.25);
            let weight = transition_weight(plan.segment);
            let mut ola = OverlapAdd::new(2, &plan);
            let mut seg = vec![0f32; plan.segment];
            let mut got = Vec::new();
            let mut region = vec![Vec::new(), Vec::new()];
            for off in plan.offsets() {
                let len = plan.chunk_len(off);
                padded_chunk(&src, off, len, &mut seg);
                let s = center_trim_start(plan.segment, len);
                let neg: Vec<f32> = seg[s..s + len].iter().map(|v| -v).collect();
                ola.add(&[&seg[s..s + len], &neg], &weight[..len]);
                let n = plan.final_until(off) - off;
                ola.take(n, &mut region);
                for (a, b) in region[0].iter().zip(&region[1]) {
                    assert!((a + b).abs() < 1e-6);
                }
                got.extend_from_slice(&region[0]);
            }
            assert_eq!(got.len(), total, "total {total}");
            let err = got.iter().zip(&src).map(|(a, b)| (a - b).abs()).fold(0f32, f32::max);
            assert!(err < 1e-4, "total {total}: max error {err}");
        }
    }
}
