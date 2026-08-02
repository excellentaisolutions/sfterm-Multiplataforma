pub fn capture_command(command: &str) -> std::process::Command {
    #[cfg(target_os = "macos")]
    {
        let mut process = std::process::Command::new("/bin/zsh");
        process.args(["-lc", command]);
        process
    }
    #[cfg(target_os = "windows")]
    {
        let mut process = std::process::Command::new("powershell.exe");
        process.args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            command,
        ]);
        process
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_shell_is_explicit_and_non_interactive() {
        let process = capture_command("Write-Output ok");
        #[cfg(target_os = "windows")]
        {
            assert_eq!(process.get_program(), "powershell.exe");
            let args: Vec<_> = process.get_args().collect();
            assert!(args.iter().any(|arg| *arg == "-NoProfile"));
            assert!(args.iter().any(|arg| *arg == "-NonInteractive"));
        }
        #[cfg(target_os = "macos")]
        {
            assert_eq!(process.get_program(), "/bin/zsh");
            assert_eq!(process.get_args().next(), Some(std::ffi::OsStr::new("-lc")));
        }
    }
}
