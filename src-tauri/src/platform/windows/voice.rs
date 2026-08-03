//! Dictado local de Windows: CPAL abre el endpoint WASAPI predeterminado,
//! captura en el formato nativo, mezcla a mono, remuestrea a 16 kHz PCM y
//! entrega un WAV a whisper.cpp. No depende de getUserMedia/WebView2.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SampleFormat, SizedSample, Stream, StreamConfig};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::State;

const TARGET_RATE: u32 = 16_000;
const MAX_RECORD_SECONDS: usize = 10 * 60;

struct Recording {
    stream: Stream,
    samples: Arc<Mutex<Vec<f32>>>,
    stream_error: Arc<Mutex<Option<String>>>,
    sample_rate: u32,
}

#[derive(Default)]
pub struct VoiceState {
    rec: Mutex<Option<Recording>>,
}

fn find_executable(names: &[&str], override_var: &str) -> Option<PathBuf> {
    if let Ok(value) = std::env::var(override_var) {
        let path = PathBuf::from(value);
        if path.is_file() {
            return Some(path);
        }
    }
    std::env::var_os("PATH")
        .into_iter()
        .flat_map(|value| std::env::split_paths(&value).collect::<Vec<_>>())
        .flat_map(|dir| names.iter().map(move |name| dir.join(name)))
        .find(|path| path.is_file())
}

fn whisper_bin() -> Option<PathBuf> {
    find_executable(&["whisper-cli.exe", "whisper-cli"], "SFTERM_WHISPER_BIN")
}

fn models_dir() -> PathBuf {
    crate::config::config_dir().join("models")
}

pub fn rank_model(name: &str) -> u8 {
    for (index, pattern) in ["large-v3-turbo", "large", "medium", "small", "base", "tiny"]
        .iter()
        .enumerate()
    {
        if name.contains(pattern) {
            return index as u8;
        }
    }
    9
}

pub fn pick_model() -> Option<PathBuf> {
    if let Ok(value) = std::env::var("SFTERM_WHISPER_MODEL") {
        let path = PathBuf::from(value);
        if path.is_file() {
            return Some(path);
        }
    }
    let mut candidates = std::fs::read_dir(models_dir())
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            let name = path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("");
            name.starts_with("ggml-") && name.ends_with(".bin")
        })
        .collect::<Vec<_>>();
    candidates.sort_by_key(|path| {
        rank_model(
            path.file_name()
                .and_then(|value| value.to_str())
                .unwrap_or(""),
        )
    });
    candidates.into_iter().next()
}

fn default_input() -> Result<(cpal::Device, cpal::SupportedStreamConfig, String), String> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or_else(|| "Windows no tiene un micrófono de entrada predeterminado".to_string())?;
    let name = device
        .name()
        .unwrap_or_else(|_| "micrófono predeterminado".to_string());
    let config = device
        .default_input_config()
        .map_err(|error| format!("WASAPI no pudo consultar {name}: {error}"))?;
    Ok((device, config, name))
}

#[tauri::command]
pub fn voice_status() -> serde_json::Value {
    let input = default_input();
    let whisper = whisper_bin();
    let model = pick_model();
    let reason = if let Err(error) = &input {
        Some(error.clone())
    } else if whisper.is_none() {
        Some("falta whisper-cli; configura SFTERM_WHISPER_BIN o instálalo".to_string())
    } else if model.is_none() {
        Some(format!(
            "falta un modelo ggml-*.bin en {} o SFTERM_WHISPER_MODEL",
            models_dir().display()
        ))
    } else {
        None
    };
    serde_json::json!({
        "ffmpeg": true,
        "whisper": whisper.is_some(),
        "model": model.map(|path| path.to_string_lossy().to_string()),
        "available": reason.is_none(),
        "reason": reason,
        "backend": "WASAPI/CPAL",
        "device": input.ok().map(|(_, _, name)| name),
    })
}

fn build_stream<T>(
    device: &cpal::Device,
    config: &StreamConfig,
    samples: Arc<Mutex<Vec<f32>>>,
    stream_error: Arc<Mutex<Option<String>>>,
) -> Result<Stream, String>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let channels = usize::from(config.channels.max(1));
    let max_samples = config.sample_rate.0 as usize * MAX_RECORD_SECONDS;
    device
        .build_input_stream(
            config,
            move |input: &[T], _| {
                let Ok(mut output) = samples.try_lock() else {
                    return;
                };
                let remaining = max_samples.saturating_sub(output.len());
                for frame in input.chunks(channels).take(remaining) {
                    let mixed = frame
                        .iter()
                        .map(|sample| f32::from_sample(*sample))
                        .sum::<f32>()
                        / frame.len() as f32;
                    output.push(mixed.clamp(-1.0, 1.0));
                }
            },
            move |error| {
                if let Ok(mut slot) = stream_error.lock() {
                    *slot = Some(error.to_string());
                }
            },
            None,
        )
        .map_err(|error| format!("WASAPI no pudo abrir el micrófono: {error}"))
}

fn start_recording() -> Result<Recording, String> {
    let (device, supported, _) = default_input()?;
    let sample_rate = supported.sample_rate().0;
    let format = supported.sample_format();
    let config: StreamConfig = supported.into();
    let samples = Arc::new(Mutex::new(Vec::new()));
    let stream_error = Arc::new(Mutex::new(None));
    let stream = match format {
        SampleFormat::I8 => {
            build_stream::<i8>(&device, &config, samples.clone(), stream_error.clone())
        }
        SampleFormat::I16 => {
            build_stream::<i16>(&device, &config, samples.clone(), stream_error.clone())
        }
        SampleFormat::I32 => {
            build_stream::<i32>(&device, &config, samples.clone(), stream_error.clone())
        }
        SampleFormat::I64 => {
            build_stream::<i64>(&device, &config, samples.clone(), stream_error.clone())
        }
        SampleFormat::U8 => {
            build_stream::<u8>(&device, &config, samples.clone(), stream_error.clone())
        }
        SampleFormat::U16 => {
            build_stream::<u16>(&device, &config, samples.clone(), stream_error.clone())
        }
        SampleFormat::U32 => {
            build_stream::<u32>(&device, &config, samples.clone(), stream_error.clone())
        }
        SampleFormat::U64 => {
            build_stream::<u64>(&device, &config, samples.clone(), stream_error.clone())
        }
        SampleFormat::F32 => {
            build_stream::<f32>(&device, &config, samples.clone(), stream_error.clone())
        }
        SampleFormat::F64 => {
            build_stream::<f64>(&device, &config, samples.clone(), stream_error.clone())
        }
        other => return Err(format!("formato de micrófono no soportado: {other}")),
    }?;
    stream
        .play()
        .map_err(|error| format!("WASAPI no pudo iniciar la captura: {error}"))?;
    Ok(Recording {
        stream,
        samples,
        stream_error,
        sample_rate,
    })
}

#[tauri::command]
pub fn voice_start(state: State<'_, VoiceState>) -> Result<(), String> {
    if whisper_bin().is_none() {
        return Err("falta whisper-cli; configura SFTERM_WHISPER_BIN o instálalo".into());
    }
    if pick_model().is_none() {
        return Err(format!(
            "falta un modelo ggml-*.bin en {} o SFTERM_WHISPER_MODEL",
            models_dir().display()
        ));
    }
    let mut slot = state.rec.lock().map_err(|_| "estado de voz bloqueado")?;
    if slot.is_some() {
        return Err("ya hay una grabación en curso".into());
    }
    *slot = Some(start_recording()?);
    Ok(())
}

fn resample_mono(input: &[f32], source_rate: u32) -> Vec<i16> {
    if input.is_empty() || source_rate == 0 {
        return Vec::new();
    }
    let output_len = input.len().saturating_mul(TARGET_RATE as usize) / source_rate as usize;
    (0..output_len)
        .map(|index| {
            let position = index as f64 * source_rate as f64 / TARGET_RATE as f64;
            let left = position.floor() as usize;
            let right = (left + 1).min(input.len() - 1);
            let fraction = (position - left as f64) as f32;
            let sample = input[left] * (1.0 - fraction) + input[right] * fraction;
            (sample.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16
        })
        .collect()
}

fn write_wav(path: &Path, samples: &[i16]) -> Result<(), String> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: TARGET_RATE,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(path, spec).map_err(|error| error.to_string())?;
    for sample in samples {
        writer
            .write_sample(*sample)
            .map_err(|error| error.to_string())?;
    }
    writer.finalize().map_err(|error| error.to_string())
}

fn transcribe_recording(recording: Recording) -> Result<String, String> {
    drop(recording.stream);
    if let Some(error) = recording
        .stream_error
        .lock()
        .map_err(|_| "estado de WASAPI bloqueado")?
        .take()
    {
        return Err(format!("la captura WASAPI falló: {error}"));
    }
    let source = std::mem::take(
        &mut *recording
            .samples
            .lock()
            .map_err(|_| "buffer de voz bloqueado")?,
    );
    let samples = resample_mono(&source, recording.sample_rate);
    if samples.len() < (TARGET_RATE as usize * 2 / 5) {
        return Err("no se grabó audio (muy corto o micrófono mudo)".into());
    }
    let whisper = whisper_bin().ok_or("whisper-cli dejó de estar disponible")?;
    let model = pick_model().ok_or("el modelo de Whisper dejó de estar disponible")?;
    let wav = std::env::temp_dir().join(format!(
        "sfterm-dictado-{}-{}.wav",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    ));
    if let Err(error) = write_wav(&wav, &samples) {
        let _ = std::fs::remove_file(&wav);
        return Err(error);
    }
    let output = std::process::Command::new(whisper)
        .args([
            "-m",
            &model.to_string_lossy(),
            "-l",
            "es",
            "-nt",
            "-np",
            "-f",
            &wav.to_string_lossy(),
        ])
        .output();
    let _ = std::fs::remove_file(&wav);
    let output = output.map_err(|error| format!("no se pudo ejecutar whisper-cli: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "whisper falló: {}",
            String::from_utf8_lossy(&output.stderr)
                .trim()
                .chars()
                .take(300)
                .collect::<String>()
        ));
    }
    let text = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    (!text.is_empty())
        .then_some(text)
        .ok_or_else(|| "no se detectó voz en el audio".to_string())
}

#[tauri::command]
pub async fn voice_stop(state: State<'_, VoiceState>) -> Result<String, String> {
    let recording = state
        .rec
        .lock()
        .map_err(|_| "estado de voz bloqueado")?
        .take()
        .ok_or("no hay una grabación en curso")?;
    tauri::async_runtime::spawn_blocking(move || transcribe_recording(recording))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn voice_cancel(state: State<'_, VoiceState>) -> Result<(), String> {
    let _ = state
        .rec
        .lock()
        .map_err(|_| "estado de voz bloqueado")?
        .take();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rank_model_prefiere_turbo_sobre_small_y_tiny() {
        assert!(rank_model("ggml-large-v3-turbo-q5_0.bin") < rank_model("ggml-small.bin"));
        assert!(rank_model("ggml-small.bin") < rank_model("ggml-base.bin"));
        assert!(rank_model("ggml-base.bin") < rank_model("ggml-tiny.bin"));
    }

    #[test]
    fn remuestreo_produce_pcm_mono_a_16khz() {
        let input = vec![0.5; 48_000];
        let output = resample_mono(&input, 48_000);
        assert_eq!(output.len(), 16_000);
        assert!(output
            .iter()
            .all(|sample| (16_000..=16_500).contains(sample)));
    }

    #[test]
    #[ignore = "abre el micrófono WASAPI real durante 700 ms"]
    fn wasapi_captura_muestras_del_microfono_real() {
        let recording = start_recording().expect("endpoint WASAPI predeterminado");
        std::thread::sleep(std::time::Duration::from_millis(700));
        drop(recording.stream);
        assert!(
            recording.samples.lock().unwrap().len() > recording.sample_rate as usize / 4,
            "WASAPI debe entregar frames aunque el ambiente esté en silencio"
        );
    }
}
