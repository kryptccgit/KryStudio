use krypt_studio_dsp::{Effect, ProcessContext};

pub const MAX_ALIGN: usize = 8192;

pub struct LatencyAligned {
    inner: Box<dyn Effect>,
    ring: [Vec<f32>; 2],
    w: usize,
}

impl LatencyAligned {
    pub fn new(inner: Box<dyn Effect>) -> Self {
        Self {
            inner,
            ring: [vec![0.0; MAX_ALIGN], vec![0.0; MAX_ALIGN]],
            w: 0,
        }
    }
}

impl Effect for LatencyAligned {
    fn prepare(&mut self, sample_rate: f32, max_frames: usize) {
        self.inner.prepare(sample_rate, max_frames);
        self.clear();
    }
    fn set_param(&mut self, index: usize, value: f32) {
        self.inner.set_param(index, value);
    }
    fn process(
        &mut self,
        ctx: &ProcessContext,
        buf: [&mut [f32]; 2],
        sidechain: Option<[&[f32]; 2]>,
    ) {
        self.inner.process(ctx, buf, sidechain);
    }
    fn latency(&self) -> usize {
        self.inner.latency()
    }
    fn reset(&mut self) {
        self.inner.reset();
        self.clear();
    }
    fn meter(&self) -> Option<f32> {
        self.inner.meter()
    }
    fn align_dry(&mut self, dry: [&mut [f32]; 2]) {
        let lat = self.inner.latency();
        if lat == 0 || lat >= MAX_ALIGN {
            return;
        }
        let n = dry[0].len().min(dry[1].len());
        let [l, r] = dry;
        let mask = MAX_ALIGN - 1;
        for i in 0..n {
            let rd = (self.w + MAX_ALIGN - lat) & mask;
            self.ring[0][self.w] = l[i];
            self.ring[1][self.w] = r[i];
            l[i] = self.ring[0][rd];
            r[i] = self.ring[1][rd];
            self.w = (self.w + 1) & mask;
        }
    }
}

impl LatencyAligned {
    fn clear(&mut self) {
        self.ring.iter_mut().for_each(|b| b.fill(0.0));
        self.w = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Delay {
        d: usize,
        buf: Vec<[f32; 2]>,
        w: usize,
    }
    impl Effect for Delay {
        fn prepare(&mut self, _: f32, _: usize) {}
        fn set_param(&mut self, _: usize, _: f32) {}
        fn process(&mut self, _: &ProcessContext, buf: [&mut [f32]; 2], _: Option<[&[f32]; 2]>) {
            let [l, r] = buf;
            for i in 0..l.len() {
                let len = self.buf.len();
                let out = self.buf[(self.w + len - self.d) % len];
                self.buf[self.w] = [l[i], r[i]];
                self.w = (self.w + 1) % len;
                l[i] = out[0];
                r[i] = out[1];
            }
        }
        fn latency(&self) -> usize {
            self.d
        }
        fn reset(&mut self) {}
    }

    #[test]
    fn dry_lines_up_with_a_latent_wet_signal() {
        let d = 37;
        let mut fx = LatencyAligned::new(Box::new(Delay {
            d,
            buf: vec![[0.0; 2]; 64],
            w: 0,
        }));
        let ctx = ProcessContext {
            sample_rate: 48000.0,
            bpm: 120.0,
            beats_per_bar: 4.0,
            playing: true,
            beat_pos: 0.0,
            frames: 32,
        };
        let src: Vec<f32> = (0..4096).map(|i| (i as f32 * 0.37).sin()).collect();
        let mut out = Vec::new();
        for block in src.chunks(32) {
            let (mut wl, mut wr) = (block.to_vec(), block.to_vec());
            let (mut dl, mut dr) = (block.to_vec(), block.to_vec());
            fx.align_dry([&mut dl, &mut dr]);
            fx.process(&ctx, [&mut wl, &mut wr], None);
            for i in 0..block.len() {
                out.push(0.5 * dl[i] + 0.5 * wl[i]);
            }
        }
        for i in d..src.len() {
            assert!((out[i] - src[i - d]).abs() < 1e-6, "sample {i}");
        }
    }
}
