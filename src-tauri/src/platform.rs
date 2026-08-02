use serde::Serialize;

pub(crate) mod desktop;
pub(crate) mod fonts;
pub(crate) mod permissions;
pub(crate) mod shell;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeatureCapability {
    pub available: bool,
    pub reason: Option<&'static str>,
}

impl FeatureCapability {
    const fn new(available: bool, reason: Option<&'static str>) -> Self {
        Self { available, reason }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformCapabilities {
    pub os: &'static str,
    pub browser_host: FeatureCapability,
    pub voice_capture: FeatureCapability,
    pub window_capture: FeatureCapability,
}

#[tauri::command]
pub fn platform_capabilities() -> PlatformCapabilities {
    #[cfg(target_os = "macos")]
    {
        PlatformCapabilities {
            os: "macos",
            browser_host: FeatureCapability::new(true, None),
            voice_capture: FeatureCapability::new(true, None),
            window_capture: FeatureCapability::new(true, None),
        }
    }

    #[cfg(target_os = "windows")]
    {
        PlatformCapabilities {
            os: "windows",
            browser_host: FeatureCapability::new(
                false,
                Some("el host WebView2 se implementará en la Fase 4"),
            ),
            voice_capture: FeatureCapability::new(
                false,
                Some("la captura WASAPI se implementará en la Fase 6"),
            ),
            window_capture: FeatureCapability::new(
                false,
                Some("la captura de ventana WebView2 se implementará en la Fase 4"),
            ),
        }
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        PlatformCapabilities {
            os: std::env::consts::OS,
            browser_host: FeatureCapability::new(
                false,
                Some("el navegador nativo no está implementado para esta plataforma"),
            ),
            voice_capture: FeatureCapability::new(
                false,
                Some("la captura de voz no está implementada para esta plataforma"),
            ),
            window_capture: FeatureCapability::new(
                false,
                Some("la captura de ventana no está implementada para esta plataforma"),
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capabilities_explain_every_unavailable_feature() {
        let capabilities = platform_capabilities();
        let json = serde_json::to_value(&capabilities).expect("serializa capacidades");
        assert!(json.get("browserHost").is_some());
        assert!(json.get("voiceCapture").is_some());
        assert!(json.get("windowCapture").is_some());
        for feature in [
            capabilities.browser_host,
            capabilities.voice_capture,
            capabilities.window_capture,
        ] {
            assert!(feature.available || feature.reason.is_some_and(|reason| !reason.is_empty()));
        }
    }
}
