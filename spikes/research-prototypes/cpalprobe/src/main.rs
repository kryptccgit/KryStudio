use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

fn run(device: &cpal::Device, cfg: cpal::StreamConfig, label: &str) {
    let log: Arc<Mutex<Vec<(Instant, usize)>>> = Arc::new(Mutex::new(Vec::with_capacity(4096)));
    let l2 = log.clone();
    let ch = cfg.channels as usize;
    let stream = device.build_output_stream(
        cfg.clone(),
        move |data: &mut [f32], _info: &cpal::OutputCallbackInfo| {
            for s in data.iter_mut() { *s = 0.0; } // silence
            if let Ok(mut v) = l2.try_lock() { if v.len() < 4096 { v.push((Instant::now(), data.len() / ch)); } }
        },
        |e| eprintln!("stream error: {e}"),
        None,
    );
    match stream {
        Err(e) => { println!("[{label}] build failed: {e}"); }
        Ok(s) => {
            s.play().unwrap();
            std::thread::sleep(Duration::from_millis(2000));
            drop(s);
            let v = log.lock().unwrap();
            let frames: Vec<usize> = v.iter().map(|x| x.1).collect();
            let mut iv: Vec<f64> = v.windows(2).map(|w| (w[1].0 - w[0].0).as_secs_f64() * 1000.0).collect();
            iv.sort_by(|a, b| a.partial_cmp(b).unwrap());
            let q = |p: f64| if iv.is_empty() { 0.0 } else { iv[((iv.len() - 1) as f64 * p) as usize] };
            let mut fs = frames.clone(); fs.sort(); fs.dedup();
            println!("[{label}] callbacks={} frames/callback distinct={:?} interval ms p50={:.2} p99={:.2} max={:.2}", v.len(), fs, q(0.5), q(0.99), q(1.0));
        }
    }
}

fn main() {
    for id in cpal::available_hosts() { println!("host available: {:?}", id); }
    let host = cpal::default_host();
    let dev = host.default_output_device().expect("no output device");
    println!("default output: {:?}", dev.description().map(|d| d.name().to_string()));
    let def = dev.default_output_config().unwrap();
    println!("default config: {:?}", def);
    let base: cpal::StreamConfig = def.config();
    run(&dev, base.clone(), "BufferSize::Default");
    for n in [128u32, 256, 480] {
        let mut c = base.clone();
        c.buffer_size = cpal::BufferSize::Fixed(n);
        run(&dev, c, &format!("BufferSize::Fixed({n})"));
    }
}
