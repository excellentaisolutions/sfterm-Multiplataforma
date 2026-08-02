pub fn restrict_directory_to_user(path: &std::path::Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| error.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        // Las raíces AppData del usuario ya heredan una DACL limitada a su
        // perfil. El transporte Named Pipe añade además su propia DACL.
        let _ = path;
    }
    Ok(())
}
