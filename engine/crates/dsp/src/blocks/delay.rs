#[derive(Clone, Debug, Default)]
pub struct DelayLine {
    buf: Vec<f32>,
    mask: usize,
    w: usize,
    written: usize,
}

impl DelayLine {
    pub fn new(max_delay: usize) -> Self {
        let size = (max_delay + 8).next_power_of_two();
        Self { buf: vec![0.0; size], mask: size - 1, w: 0, written: 0 }
    }

    pub fn capacity(&self) -> usize {
        self.buf.len().saturating_sub(8)
    }

    #[inline]
    pub fn push(&mut self, x: f32) {
        self.w = (self.w + 1) & self.mask;
        self.buf[self.w] = x;
        if self.written < self.buf.len() {
            self.written += 1;
        }
    }

    #[inline]
    pub fn read(&self, d: usize) -> f32 {
        if d >= self.written {
            return 0.0;
        }
        self.buf[(self.w.wrapping_sub(d)) & self.mask]
    }

    #[inline]
    pub fn read_frac(&self, d: f32) -> f32 {
        let d = if d.is_finite() { d.clamp(1.0, self.capacity() as f32) } else { 1.0 };
        let i = d.floor();
        let f = d - i;
        let i = i as usize;
        let xm1 = self.read(i - 1);
        let x0 = self.read(i);
        let x1 = self.read(i + 1);
        let x2 = self.read(i + 2);
        hermite(f, xm1, x0, x1, x2)
    }

    #[inline]
    pub fn read_lin(&self, d: f32) -> f32 {
        let d = if d.is_finite() { d.clamp(0.0, self.capacity() as f32) } else { 0.0 };
        let i = d.floor();
        let f = d - i;
        let i = i as usize;
        let a = self.read(i);
        let b = self.read(i + 1);
        a + (b - a) * f
    }

    #[inline]
    pub fn read_f64(&self, d: f64) -> f32 {
        let cap = self.capacity().saturating_sub(3) as f64;
        let d = if d.is_finite() { d.clamp(0.0, cap) } else { 0.0 };
        let i = d.floor();
        let f = (d - i) as f32;
        let i = i as usize;
        if i == 0 {
            let a = self.read(0);
            if f == 0.0 {
                return a;
            }
            return a + (self.read(1) - a) * f;
        }
        hermite(f, self.read(i - 1), self.read(i), self.read(i + 1), self.read(i + 2))
    }

    pub fn clear(&mut self) {
        self.written = 0;
    }

    pub fn zero(&mut self) {
        self.buf.iter_mut().for_each(|v| *v = 0.0);
        self.written = 0;
    }
}

#[inline]
pub fn hermite(f: f32, xm1: f32, x0: f32, x1: f32, x2: f32) -> f32 {
    let c0 = x0;
    let c1 = 0.5 * (x1 - xm1);
    let c2 = xm1 - 2.5 * x0 + 2.0 * x1 - 0.5 * x2;
    let c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
    ((c3 * f + c2) * f + c1) * f + c0
}

#[derive(Clone, Debug, Default)]
pub struct Allpass {
    line: DelayLine,
    pub len: f32,
    pub g: f32,
}

impl Allpass {
    pub fn new(max_len: usize, len: f32, g: f32) -> Self {
        Self { line: DelayLine::new(max_len + 4), len, g }
    }

    #[inline]
    pub fn tick(&mut self, x: f32) -> f32 {
        let d = self.line.read((self.len as usize).max(1) - 1);
        let v = x + self.g * d;
        let y = d - self.g * v;
        self.line.push(super::flush(v));
        y
    }

    #[inline]
    pub fn tick_mod(&mut self, x: f32, len: f32) -> f32 {
        let d = self.line.read_lin((len - 1.0).max(0.0));
        let v = x + self.g * d;
        let y = d - self.g * v;
        self.line.push(super::flush(v));
        y
    }

    #[inline]
    pub fn tap(&self, d: usize) -> f32 {
        self.line.read(d)
    }

    pub fn clear(&mut self) {
        self.line.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn integer_delay_and_clear() {
        let mut d = DelayLine::new(100);
        for i in 0..50 {
            d.push(i as f32);
        }
        assert_eq!(d.read(0), 49.0);
        assert_eq!(d.read(10), 39.0);
        assert_eq!(d.read(60), 0.0);
        d.clear();
        assert_eq!(d.read(0), 0.0);
        d.push(7.0);
        assert_eq!(d.read(0), 7.0);
        assert_eq!(d.read(1), 0.0);
    }

    #[test]
    fn frac_read_interpolates() {
        let mut d = DelayLine::new(100);
        for i in 0..50 {
            d.push(i as f32);
        }
        let v = d.read_frac(10.5);
        assert!((v - 38.5).abs() < 1e-4, "{v}");
    }
}
