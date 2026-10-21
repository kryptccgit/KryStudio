use windows::Win32::Media::Audio::*;
use windows::Win32::System::Com::*;

fn main() -> windows::core::Result<()> {
    unsafe {
        CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;
        let en: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let coll = en.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)?;
        let n = coll.GetCount()?;
        for i in 0..n {
            let dev = coll.Item(i)?;
            let store = dev.OpenPropertyStore(STGM_READ)?; let pv = store.GetValue(&windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName)?; let id = pv.to_string();
            let c3: IAudioClient3 = dev.Activate(CLSCTX_ALL, None)?;
            let fmt = c3.GetMixFormat()?;
            let sr = (*fmt).nSamplesPerSec;
            let (mut def, mut fun, mut min, mut max) = (0u32, 0u32, 0u32, 0u32);
            let r3 = c3.GetSharedModeEnginePeriod(fmt, &mut def, &mut fun, &mut min, &mut max);
            let (mut dp, mut mp) = (0i64, 0i64);
            let _ = c3.GetDevicePeriod(Some(&mut dp), Some(&mut mp));
            println!("endpoint {i} ({}): mixfmt {} Hz {} ch", id, sr, { let c = (*fmt).nChannels; c });
            match r3 {
                Ok(()) => println!("  IAudioClient3 shared engine period frames: default={def} fundamental={fun} min={min} max={max}  (min = {:.2} ms)", min as f64 * 1000.0 / sr as f64),
                Err(e) => println!("  IAudioClient3 GetSharedModeEnginePeriod failed: {e}"),
            }
            println!("  GetDevicePeriod: default={:.2} ms, minimum(exclusive)={:.2} ms", dp as f64 / 10_000.0, mp as f64 / 10_000.0);
        }
    }
    Ok(())
}
