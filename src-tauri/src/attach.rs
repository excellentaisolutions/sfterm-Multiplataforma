//! ADJUNTOS del lector (26 jul 2026).
//!
//! Dos caminos, uno por cada direccion de la imagen:
//!
//!  1. **SALE** (`attach_save`) — lo que Daniel pega/arrastra en el composer se
//!     materializa a un archivo y viaja al agente como RUTA dentro del prompt
//!     ("Archivos adjuntos (leelos/analizalos): - /ruta"), que claude LEE con
//!     su herramienta Read. Por ruta y no por base64 a proposito: el transcript
//!     queda liviano (un blob inline pesa hasta 4MB y le come la ventana al
//!     espejo), la imagen se puede volver a abrir despues, y es el UNICO camino
//!     que sirve igual para los cuatro gestos (pegar, Finder, arbol, boton 📎).
//!     Resucitado de `agent.rs`, muerto en la purga del chat nativo (21 jul).
//!
//!  2. **ENTRA** (`transcript_image`) — las imagenes que YA viven dentro de un
//!     transcript (las que Daniel pego en el TUI con ^V) estan como base64
//!     inline. `readTail` las STRIPEA en el shell antes de cruzar el IPC (si no,
//!     un solo screenshot deja al lector en blanco), asi que el frontend solo
//!     sabe que ahi hubo una imagen. Al hacer click, este comando la saca del
//!     jsonl bajo demanda y devuelve su data URI.
//!
//! ⚠️ INVARIANTE DE INDICE: `collect_images` recorre el mensaje en ORDEN DE
//! DOCUMENTO (content[] en orden; dentro de un tool_result, su content[] en
//! orden) y el frontend recorre EXACTAMENTE igual (transcript.ts::collectImages).
//! El indice es el unico amarre entre los dos lados: si un lado cambia el
//! recorrido y el otro no, la imagen que se abre no es la que se clickeo.

use std::io::{BufRead, BufReader};
use std::path::PathBuf;

/// Carpeta persistente de adjuntos. En Windows usa AppData/Local (no temp): el
/// asset protocol solo sirve $HOME (asi el thumbnail se puede pintar) y la
/// ruta sigue viva tras un reboot — el transcript la referencia para siempre.
fn attach_dir() -> PathBuf {
    crate::config::state_dir().join("adjuntos")
}

/// Guarda un adjunto pegado (imagen del clipboard) y devuelve su ruta.
/// El payload viene en base64: los bytes crudos por invoke serian un array
/// JSON de numeros (lento para imagenes de MB).
#[tauri::command]
pub fn attach_save(data_b64: String, ext: String) -> Result<String, String> {
    let safe_ext: String = ext
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(5)
        .collect();
    let ext = if safe_ext.is_empty() { "png".into() } else { safe_ext };
    let bytes = b64_decode(&data_b64).ok_or("base64 invalido")?;
    if bytes.is_empty() {
        return Err("adjunto vacio".into());
    }
    let dir = attach_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = dir.join(format!("pegado-{ts}.{ext}"));
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

/// Una imagen del DISCO como data URI, para pintarla en el webview.
///
/// ¿Por que no `convertFileSrc` (el asset protocol de Tauri), que es una linea?
/// Porque **si falla, falla en silencio**: el `<img>` dispara onError, el
/// thumbnail cae al chip de texto y no queda ni un rastro de por que. Fue el
/// reporte de Daniel del 27 jul ("las imagenes insertadas no las puedo ver"),
/// y depurarlo desde fuera del webview es carisimo. Este camino, en cambio, es
/// el MISMO que ya funciona para las imagenes del transcript: un comando que
/// devuelve bytes y dice en castellano por que no pudo. Cuesta una copia en
/// base64 (~33% mas) que la cache de `images.ts` amortiza.
///
/// Tope de 24 MB: un data URI vive en el heap del webview, y una captura de
/// pantalla de un 6K ronda los 8. Pasado eso conviene el visor de archivos.
#[tauri::command]
pub async fn local_image(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || image_data_uri(&path))
        .await
        .map_err(|e| e.to_string())?
}

/// La lógica sola, sin el runtime asincrono: asi se puede probar de verdad.
fn image_data_uri(path: &str) -> Result<String, String> {
    let p = crate::pty::expand_tilde(path);
    let meta = std::fs::metadata(&p).map_err(|e| format!("no pude leer {p}: {e}"))?;
    if !meta.is_file() {
        return Err(format!("{p} no es un archivo"));
    }
    if meta.len() > 24 * 1024 * 1024 {
        return Err(format!(
            "imagen de {} MB: demasiado grande para el visor inline",
            meta.len() / 1024 / 1024
        ));
    }
    let ext = std::path::Path::new(&p)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let media = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "heic" | "heif" => "image/heic",
        "svg" => "image/svg+xml",
        otro => return Err(format!("extension no pintable: .{otro}")),
    };
    let bytes = std::fs::read(&p).map_err(|e| e.to_string())?;
    Ok(format!("data:{media};base64,{}", b64_encode(&bytes)))
}

/// Saca la imagen `index` (orden de documento) del mensaje `uuid` de un
/// transcript y la devuelve como data URI listo para un <img src>.
#[tauri::command]
pub async fn transcript_image(
    path: String,
    uuid: String,
    index: usize,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = crate::pty::expand_tilde(&path);
        let f = std::fs::File::open(&path).map_err(|e| e.to_string())?;
        // filtro barato antes de parsear: las lineas de un transcript pesan
        // MBs cuando traen imagenes y parsear todas seria absurdo.
        // "uuid":"X" NO matchea dentro de "parentUuid":"X" ni "leafUuid":"X"
        // (la U va en mayuscula ahi), asi que el ancla es exacta.
        let needle = format!("\"uuid\":\"{uuid}\"");
        let mut reader = BufReader::new(f);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => break,
                Ok(_) => {}
                Err(e) => return Err(e.to_string()),
            }
            if !line.contains(&needle) {
                continue;
            }
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            if v.get("uuid").and_then(|u| u.as_str()) != Some(uuid.as_str()) {
                continue;
            }
            let Some(msg) = v.get("message") else { continue };
            let imgs = collect_images(msg);
            let Some((media, data)) = imgs.into_iter().nth(index) else {
                return Err(format!("el mensaje no tiene imagen #{index}"));
            };
            if data.is_empty() {
                return Err("esa imagen no trae bytes".into());
            }
            return Ok(format!("data:{media};base64,{data}"));
        }
        Err("no encontre ese mensaje en el transcript".into())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// (media_type, base64) de cada imagen del mensaje, en ORDEN DE DOCUMENTO.
/// Espejo exacto de transcript.ts::collectImages — ver el invariante de arriba.
fn collect_images(msg: &serde_json::Value) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let Some(content) = msg.get("content").and_then(|c| c.as_array()) else {
        return out;
    };
    for b in content {
        match b.get("type").and_then(|t| t.as_str()) {
            Some("image") => push_image(b, &mut out),
            Some("tool_result") => {
                if let Some(inner) = b.get("content").and_then(|c| c.as_array()) {
                    for ib in inner {
                        if ib.get("type").and_then(|t| t.as_str()) == Some("image") {
                            push_image(ib, &mut out);
                        }
                    }
                }
            }
            _ => {}
        }
    }
    out
}

/// ⚠️ CUENTA TODO bloque `image`, tenga bytes o no. Es deliberado: el frontend
/// numera sobre el tail YA STRIPEADO (donde TODAS las imagenes tienen
/// `data:""`), asi que si aqui saltaramos las vacias los indices de los dos
/// lados dejarian de casar. Una imagen sin bytes se detecta al final del
/// camino (`transcript_image`), no descontandola de la numeracion.
fn push_image(block: &serde_json::Value, out: &mut Vec<(String, String)>) {
    let src = block.get("source");
    let media = src
        .and_then(|s| s.get("media_type"))
        .and_then(|m| m.as_str())
        .unwrap_or("image/png");
    let data = src
        .and_then(|s| s.get("data"))
        .and_then(|d| d.as_str())
        .unwrap_or("");
    out.push((media.to_string(), data.to_string()));
}

/// Decodificador base64 standard minimo (sin crate extra).
fn b64_decode(s: &str) -> Option<Vec<u8>> {
    const TBL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut rev = [255u8; 256];
    for (i, &c) in TBL.iter().enumerate() {
        rev[c as usize] = i as u8;
    }
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let mut buf = 0u32;
    let mut bits = 0u8;
    for c in s.bytes() {
        if c == b'=' || c == b'\n' || c == b'\r' {
            continue;
        }
        let v = rev[c as usize];
        if v == 255 {
            return None;
        }
        buf = (buf << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
        }
    }
    Some(out)
}

/// Codificador base64 standard (el par del de arriba, sin crate extra).
fn b64_encode(bytes: &[u8]) -> String {
    const TBL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for tro in bytes.chunks(3) {
        let b = [tro[0], *tro.get(1).unwrap_or(&0), *tro.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(TBL[(n >> 18) as usize & 63] as char);
        out.push(TBL[(n >> 12) as usize & 63] as char);
        out.push(if tro.len() > 1 { TBL[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if tro.len() > 2 { TBL[n as usize & 63] as char } else { '=' });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{b64_decode, b64_encode, collect_images, image_data_uri};

    /// El camino completo del thumbnail: archivo real en disco → data URI que
    /// un <img src> pueda pintar. Es el reemplazo del asset protocol, asi que
    /// si esto pasa, la miniatura del composer se ve.
    #[test]
    fn imagen_del_disco_sale_como_data_uri_pintable() {
        // PNG 1x1 valido (el mismo que sirve de fixture en media tests)
        let png = b64_decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        )
        .unwrap();
        let dir = std::env::temp_dir().join("sfterm-test-img");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("captura.png");
        std::fs::write(&p, &png).unwrap();

        let uri = image_data_uri(p.to_str().unwrap()).unwrap();
        assert!(uri.starts_with("data:image/png;base64,"), "mime equivocado: {}", &uri[..40]);
        let vuelta = b64_decode(uri.split_once(",").unwrap().1).unwrap();
        assert_eq!(vuelta, png, "los bytes no sobrevivieron el viaje");

        // y los caminos que NO deben pintar dicen POR QUE (el asset protocol
        // fallaba mudo: ese fue el bug)
        let txt = dir.join("notas.txt");
        std::fs::write(&txt, b"hola").unwrap();
        assert!(image_data_uri(txt.to_str().unwrap()).unwrap_err().contains("no pintable"));
        assert!(image_data_uri("/no/existe/foto.png").unwrap_err().contains("no pude leer"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn b64_decode_roundtrip() {
        assert_eq!(b64_decode("aG9sYQ==").unwrap(), b"hola");
        assert_eq!(b64_decode("").unwrap(), b"");
        assert!(b64_decode("no-es-base64!").is_none());
    }

    /// El encoder es el que arma el data URI de una imagen del disco: si el
    /// padding se rompe, el webview pinta un cuadro roto y el thumbnail cae al
    /// chip de texto (el sintoma exacto que reporto Daniel).
    #[test]
    fn b64_encode_cubre_los_tres_restos() {
        assert_eq!(b64_encode(b""), "");
        assert_eq!(b64_encode(b"h"), "aA==");
        assert_eq!(b64_encode(b"ho"), "aG8=");
        assert_eq!(b64_encode(b"hola"), "aG9sYQ==");
        // ida y vuelta sobre bytes binarios de verdad (cabecera PNG)
        let png = [0x89u8, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00];
        assert_eq!(b64_decode(&b64_encode(&png)).unwrap(), png);
    }

    /// El caso de Daniel: pega un screenshot en el TUI y claude lo guarda como
    /// [texto "[Image #1] …", imagen]. La imagen es el indice 0 (el texto no
    /// cuenta): el orden es el de las IMAGENES, no el de los bloques.
    #[test]
    fn imagen_pegada_en_el_tui_es_el_indice_cero() {
        let msg = serde_json::json!({
            "role": "user",
            "content": [
                { "type": "text", "text": "[Image #1] listo mi perro" },
                { "type": "image", "source": { "type": "base64", "media_type": "image/jpeg", "data": "QUJD" } }
            ]
        });
        let imgs = collect_images(&msg);
        assert_eq!(imgs.len(), 1);
        assert_eq!(imgs[0].0, "image/jpeg");
        assert_eq!(imgs[0].1, "QUJD");
    }

    /// Orden de documento con imagenes ANIDADAS en un tool_result (screenshots
    /// de Playwright y demas): el indice global las cuenta en el mismo orden en
    /// que el frontend las numera.
    #[test]
    fn orden_de_documento_cuenta_las_de_tool_result() {
        let msg = serde_json::json!({
            "role": "user",
            "content": [
                { "type": "image", "source": { "media_type": "image/png", "data": "AAA" } },
                { "type": "tool_result", "tool_use_id": "t1", "content": [
                    { "type": "text", "text": "listo" },
                    { "type": "image", "source": { "media_type": "image/png", "data": "BBB" } },
                    { "type": "image", "source": { "media_type": "image/webp", "data": "CCC" } }
                ]},
                { "type": "image", "source": { "media_type": "image/gif", "data": "DDD" } }
            ]
        });
        let imgs = collect_images(&msg);
        let datos: Vec<&str> = imgs.iter().map(|(_, d)| d.as_str()).collect();
        assert_eq!(datos, vec!["AAA", "BBB", "CCC", "DDD"]);
        assert_eq!(imgs[3].0, "image/gif");
    }

    /// EL INVARIANTE: un blob vacio SI cuenta para la numeracion. El frontend
    /// numera sobre el tail stripeado (todas vacias); si aqui las descontaramos,
    /// clickear la segunda imagen abriria la primera.
    #[test]
    fn blob_vacio_igual_ocupa_su_indice() {
        let msg = serde_json::json!({
            "content": [
                { "type": "image", "source": { "media_type": "image/png", "data": "" } },
                { "type": "image", "source": { "media_type": "image/png", "data": "ZZZ" } }
            ]
        });
        let imgs = collect_images(&msg);
        assert_eq!(imgs.len(), 2);
        assert_eq!(imgs[1].1, "ZZZ");
    }

    /// Un bloque image sin `source` usable no rompe el conteo (queda vacio).
    #[test]
    fn image_sin_source_no_corre_los_indices() {
        let msg = serde_json::json!({
            "content": [
                { "type": "image" },
                { "type": "image", "source": { "media_type": "image/png", "data": "YYY" } }
            ]
        });
        let imgs = collect_images(&msg);
        assert_eq!(imgs.len(), 2);
        assert_eq!(imgs[0].1, "");
        assert_eq!(imgs[1].1, "YYY");
    }

    #[test]
    fn mensaje_sin_content_no_truena() {
        assert!(collect_images(&serde_json::json!({ "role": "user" })).is_empty());
        assert!(collect_images(&serde_json::json!({ "content": "texto plano" })).is_empty());
    }
}
