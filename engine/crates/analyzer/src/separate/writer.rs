use std::fs::File;
use std::io::BufWriter;
use std::path::{Path, PathBuf};

use hound::{SampleFormat, WavSpec, WavWriter};

const FLOOR_DB: f32 = -120.0;

pub struct StemInfo {
    pub name: String,
    pub path: PathBuf,
    pub peak_db: f32,
    pub rms_db: f32,
}

struct StemFile {
    name: String,
    tmp: PathBuf,
    path: PathBuf,
    writer: Option<WavWriter<BufWriter<File>>>,
    written: u64,
    peak: f32,
    sum_sq: f64,
    renamed: bool,
}

pub struct StemFiles {
    files: Vec<StemFile>,
    frames: u64,
    done: bool,
}

impl StemFiles {
    pub fn create(out_dir: &Path, names: &[&str], sample_rate: u32, frames: u64) -> Result<Self, String> {
        std::fs::create_dir_all(out_dir).map_err(|e| format!("Cannot create the stem folder {}: {e}", out_dir.display()))?;
        let spec = WavSpec { channels: 2, sample_rate, bits_per_sample: 32, sample_format: SampleFormat::Float };
        let mut me = Self { files: Vec::with_capacity(names.len()), frames, done: false };
        for name in names {
            let path = out_dir.join(format!("{name}.wav"));
            let tmp = out_dir.join(format!("{name}.wav.partial"));
            let writer = WavWriter::create(&tmp, spec).map_err(|e| format!("Cannot write {}: {e}", tmp.display()))?;
            me.files.push(StemFile { name: name.to_string(), tmp, path, writer: Some(writer), written: 0, peak: 0.0, sum_sq: 0.0, renamed: false });
        }
        Ok(me)
    }

    pub fn write(&mut self, i: usize, left: &[f32], right: &[f32]) -> Result<(), String> {
        let total = self.frames;
        let f = &mut self.files[i];
        let n = (left.len() as u64).min(total - f.written) as usize;
        let w = f.writer.as_mut().ok_or("stem writer already closed")?;
        for (&l, &r) in left[..n].iter().zip(&right[..n]) {
            for s in [l, r] {
                let s = if s.is_finite() { s } else { 0.0 };
                f.peak = f.peak.max(s.abs());
                f.sum_sq += f64::from(s) * f64::from(s);
                w.write_sample(s).map_err(|e| format!("Cannot write {}: {e}", f.tmp.display()))?;
            }
        }
        f.written += n as u64;
        Ok(())
    }

    pub fn finish(mut self) -> Result<Vec<StemInfo>, String> {
        let total = self.frames;
        for f in &mut self.files {
            let mut w = f.writer.take().ok_or("stem writer already closed")?;
            for _ in f.written..total {
                w.write_sample(0f32).and_then(|_| w.write_sample(0f32)).map_err(|e| format!("Cannot write {}: {e}", f.tmp.display()))?;
            }
            f.written = total;
            w.finalize().map_err(|e| format!("Cannot finish {}: {e}", f.tmp.display()))?;
        }
        for f in &mut self.files {
            std::fs::rename(&f.tmp, &f.path).map_err(|e| format!("Cannot move {} into place: {e}", f.path.display()))?;
            f.renamed = true;
        }
        self.done = true;
        let samples = (total * 2).max(1) as f64;
        Ok(self
            .files
            .iter()
            .map(|f| StemInfo {
                name: f.name.clone(),
                path: f.path.clone(),
                peak_db: db(f64::from(f.peak)),
                rms_db: db((f.sum_sq / samples).sqrt()),
            })
            .collect())
    }
}

fn db(amplitude: f64) -> f32 {
    if amplitude > 0.0 {
        ((20.0 * amplitude.log10()) as f32).max(FLOOR_DB)
    } else {
        FLOOR_DB
    }
}

impl Drop for StemFiles {
    fn drop(&mut self) {
        if self.done {
            return;
        }
        for f in &mut self.files {
            drop(f.writer.take());
            let _ = std::fs::remove_file(&f.tmp);
            if f.renamed {
                let _ = std::fs::remove_file(&f.path);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("krypt-stems-writer-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn writes_exact_length_and_levels() {
        let dir = tmp_dir("ok");
        let mut files = StemFiles::create(&dir, &["drums", "bass"], 48_000, 10).unwrap();
        files.write(0, &[0.5; 6], &[-0.5; 6]).unwrap();
        files.write(0, &[0.5; 6], &[-0.5; 6]).unwrap();
        files.write(1, &[0.0; 3], &[0.0; 3]).unwrap();
        let out = files.finish().unwrap();
        assert_eq!(out.len(), 2);
        let r = hound::WavReader::open(&out[0].path).unwrap();
        assert_eq!((r.spec().channels, r.spec().sample_rate, r.spec().bits_per_sample), (2, 48_000, 32));
        assert_eq!(r.duration(), 10);
        assert!((out[0].peak_db - (-6.0206)).abs() < 1e-3);
        assert!((out[0].rms_db - (-6.0206)).abs() < 1e-3);
        assert_eq!(hound::WavReader::open(&out[1].path).unwrap().duration(), 10);
        assert_eq!(out[1].peak_db, FLOOR_DB);
        assert!(!dir.join("drums.wav.partial").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn dropping_unfinished_removes_partials() {
        let dir = tmp_dir("drop");
        let mut files = StemFiles::create(&dir, &["vocals"], 44_100, 100).unwrap();
        files.write(0, &[0.1; 50], &[0.1; 50]).unwrap();
        assert!(dir.join("vocals.wav.partial").exists());
        drop(files);
        assert!(!dir.join("vocals.wav.partial").exists());
        assert!(!dir.join("vocals.wav").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
