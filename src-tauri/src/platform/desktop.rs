#[cfg(target_os = "macos")]
pub fn reveal(path: &str) -> Result<(), String> {
    std::process::Command::new("open")
        .args(["-R", path])
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "windows")]
pub fn reveal(path: &str) -> Result<(), String> {
    std::process::Command::new("explorer.exe")
        .args(["/select,", path])
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
pub fn trash(path: &str) -> Result<(), String> {
    use objc2_foundation::{NSFileManager, NSString, NSURL};

    let url = NSURL::fileURLWithPath(&NSString::from_str(path));
    NSFileManager::defaultManager()
        .trashItemAtURL_resultingItemURL_error(&url, None)
        .map_err(|error| error.localizedDescription().to_string())
}

#[cfg(target_os = "windows")]
pub fn trash(path: &str) -> Result<(), String> {
    let path = path.to_owned();
    // IFileOperation is an STA COM API. Use a fresh thread so this operation
    // never inherits Tauri's apartment model and never shells out with a path.
    std::thread::spawn(move || recycle_with_file_operation(&path))
        .join()
        .map_err(|_| "el hilo de la Papelera finalizo inesperadamente".to_string())?
}

#[cfg(target_os = "windows")]
fn recycle_with_file_operation(path: &str) -> Result<(), String> {
    use windows::core::HSTRING;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Shell::{
        FileOperation, IFileOperation, IShellItem, SHCreateItemFromParsingName, FOFX_EARLYFAILURE,
        FOFX_RECYCLEONDELETE, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT,
    };

    struct ComApartment;
    impl Drop for ComApartment {
        fn drop(&mut self) {
            unsafe { CoUninitialize() };
        }
    }

    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED)
            .ok()
            .map_err(|error| format!("no se pudo inicializar COM: {error}"))?;
    }
    let _apartment = ComApartment;

    let item: IShellItem = unsafe { SHCreateItemFromParsingName(&HSTRING::from(path), None) }
        .map_err(|error| format!("no se pudo abrir el item para la Papelera: {error}"))?;
    let operation: IFileOperation =
        unsafe { CoCreateInstance(&FileOperation, None, CLSCTX_INPROC_SERVER) }
            .map_err(|error| format!("no se pudo crear IFileOperation: {error}"))?;
    let flags = FOF_ALLOWUNDO
        | FOFX_RECYCLEONDELETE
        | FOFX_EARLYFAILURE
        | FOF_NOCONFIRMATION
        | FOF_NOERRORUI
        | FOF_SILENT;
    unsafe {
        operation
            .SetOperationFlags(flags)
            .and_then(|_| operation.DeleteItem(&item, None))
            .and_then(|_| operation.PerformOperations())
            .map_err(|error| format!("IFileOperation no pudo mover el item: {error}"))?;
        if operation
            .GetAnyOperationsAborted()
            .map_err(|error| format!("no se pudo consultar IFileOperation: {error}"))?
            .as_bool()
        {
            return Err("la operacion de Papelera fue cancelada".into());
        }
    }
    Ok(())
}

#[cfg(all(target_os = "windows", test))]
pub(crate) fn create_test_junction(
    link: &std::path::Path,
    target: &std::path::Path,
) -> Result<(), String> {
    // Helper exclusivo de test: mantiene la dependencia del ejecutable nativo
    // dentro del adaptador Windows y pasa ambos paths sin interpolarlos.
    let status = std::process::Command::new("powershell.exe")
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "New-Item -ItemType Junction -Path $env:SFTERM_LINK -Target $env:SFTERM_TARGET | Out-Null",
        ])
        .env("SFTERM_LINK", link)
        .env("SFTERM_TARGET", target)
        .status()
        .map_err(|error| format!("no se pudo iniciar PowerShell: {error}"))?;
    status
        .success()
        .then_some(())
        .ok_or_else(|| "PowerShell no pudo crear el junction de prueba".to_string())
}

#[cfg(target_os = "macos")]
pub fn open_url(url: &str) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "windows")]
pub fn open_url(url: &str) -> Result<(), String> {
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let target = HSTRING::from(url);
    let verb = HSTRING::from("open");
    let result = unsafe {
        ShellExecuteW(
            None,
            &verb,
            &target,
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    let code = result.0 as isize;
    if code > 32 {
        Ok(())
    } else {
        Err(format!(
            "ShellExecuteW no pudo abrir la URL (codigo {code})"
        ))
    }
}
