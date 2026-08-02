// Transporte local del daemon. El framing vive en `proto`; aquí solo cambia
// el stream: Unix socket en macOS y Named Pipe byte-mode en Windows.

use std::io::{self, Read, Write};

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use std::os::unix::net::{UnixListener, UnixStream};

    pub struct Stream(pub UnixStream);

    impl Stream {
        pub fn try_clone(&self) -> io::Result<Self> {
            self.0.try_clone().map(Self)
        }

        pub fn wait_readable(&self, _timeout: std::time::Duration) -> io::Result<bool> {
            Ok(true)
        }
    }

    impl Read for Stream {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            self.0.read(buf)
        }
    }

    impl Write for Stream {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0.write(buf)
        }

        fn flush(&mut self) -> io::Result<()> {
            self.0.flush()
        }
    }

    pub struct Listener(UnixListener);

    impl Listener {
        pub fn bind() -> io::Result<Self> {
            UnixListener::bind(crate::ptyd::socket_path()).map(Self)
        }

        pub fn accept(&self) -> io::Result<Stream> {
            self.0.accept().map(|(stream, _)| Stream(stream))
        }
    }

    pub fn connect() -> io::Result<Stream> {
        UnixStream::connect(crate::ptyd::socket_path()).map(Stream)
    }

    pub fn cleanup_endpoint() {
        let _ = std::fs::remove_file(crate::ptyd::socket_path());
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use super::*;
    use std::ffi::c_void;
    use std::fs::File;
    use std::os::windows::io::FromRawHandle;
    use std::ptr::{null, null_mut};

    type Handle = *mut c_void;
    const INVALID_HANDLE_VALUE: Handle = -1isize as Handle;
    const GENERIC_READ: u32 = 0x8000_0000;
    const GENERIC_WRITE: u32 = 0x4000_0000;
    const OPEN_EXISTING: u32 = 3;
    const FILE_ATTRIBUTE_NORMAL: u32 = 0x80;
    const FILE_FLAG_FIRST_PIPE_INSTANCE: u32 = 0x0008_0000;
    const PIPE_ACCESS_DUPLEX: u32 = 0x0000_0003;
    const PIPE_TYPE_BYTE: u32 = 0;
    const PIPE_READMODE_BYTE: u32 = 0;
    const PIPE_WAIT: u32 = 0;
    const PIPE_UNLIMITED_INSTANCES: u32 = 255;
    const ERROR_PIPE_BUSY: u32 = 231;
    const ERROR_PIPE_CONNECTED: u32 = 535;
    const SDDL_REVISION_1: u32 = 1;

    #[repr(C)]
    struct SecurityAttributes {
        length: u32,
        security_descriptor: *mut c_void,
        inherit_handle: i32,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateNamedPipeW(
            name: *const u16,
            open_mode: u32,
            pipe_mode: u32,
            max_instances: u32,
            out_buffer_size: u32,
            in_buffer_size: u32,
            default_timeout: u32,
            security_attributes: *const c_void,
        ) -> Handle;
        fn ConnectNamedPipe(pipe: Handle, overlapped: *mut c_void) -> i32;
        fn CreateFileW(
            name: *const u16,
            desired_access: u32,
            share_mode: u32,
            security_attributes: *const c_void,
            creation_disposition: u32,
            flags_and_attributes: u32,
            template_file: Handle,
        ) -> Handle;
        fn WaitNamedPipeW(name: *const u16, timeout: u32) -> i32;
        fn PeekNamedPipe(
            pipe: Handle,
            buffer: *mut c_void,
            buffer_size: u32,
            bytes_read: *mut u32,
            total_bytes_available: *mut u32,
            bytes_left_this_message: *mut u32,
        ) -> i32;
        fn GetLastError() -> u32;
        fn LocalFree(memory: *mut c_void) -> *mut c_void;
    }

    #[link(name = "advapi32")]
    extern "system" {
        fn ConvertStringSecurityDescriptorToSecurityDescriptorW(
            descriptor: *const u16,
            revision: u32,
            security_descriptor: *mut *mut c_void,
            descriptor_size: *mut u32,
        ) -> i32;
    }

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn last_error() -> io::Error {
        io::Error::last_os_error()
    }

    pub struct Stream(File);

    impl Stream {
        pub fn try_clone(&self) -> io::Result<Self> {
            self.0.try_clone().map(Self)
        }

        /// Un `ReadFile` síncrono pendiente en un handle duplicado serializa
        /// también el `WriteFile` del otro hilo sobre el mismo objeto pipe.
        /// Sondear antes de leer conserva el full-duplex sin requerir OVERLAPPED.
        pub fn wait_readable(&self, timeout: std::time::Duration) -> io::Result<bool> {
            let deadline = std::time::Instant::now() + timeout;
            loop {
                let mut available = 0u32;
                if unsafe {
                    PeekNamedPipe(
                        self.0.as_raw_handle(),
                        null_mut(),
                        0,
                        null_mut(),
                        &mut available,
                        null_mut(),
                    )
                } == 0
                {
                    return Err(last_error());
                }
                if available > 0 {
                    return Ok(true);
                }
                if std::time::Instant::now() >= deadline {
                    return Ok(false);
                }
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
        }
    }

    impl Read for Stream {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            self.0.read(buf)
        }
    }

    impl Write for Stream {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0.write(buf)
        }

        fn flush(&mut self) -> io::Result<()> {
            self.0.flush()
        }
    }

    pub struct Listener {
        name: Vec<u16>,
        pending: std::sync::Mutex<Option<File>>,
        security: PipeSecurity,
    }

    impl Listener {
        pub fn bind() -> io::Result<Self> {
            let name = wide(&crate::ptyd::pipe_name());
            let security = PipeSecurity::current_user_only()?;
            let first = create_instance(&name, true, &security)?;
            Ok(Self {
                name,
                pending: std::sync::Mutex::new(Some(first)),
                security,
            })
        }

        pub fn accept(&self) -> io::Result<Stream> {
            let mut pending = self.pending.lock().unwrap();
            let file = match pending.take() {
                Some(file) => file,
                None => create_instance(&self.name, false, &self.security)?,
            };
            let connected = unsafe { ConnectNamedPipe(file.as_raw_handle(), null_mut()) };
            if connected == 0 && unsafe { GetLastError() } != ERROR_PIPE_CONNECTED {
                return Err(last_error());
            }
            Ok(Stream(file))
        }
    }

    use std::os::windows::io::{AsRawHandle, RawHandle};

    struct PipeSecurity(*mut c_void);

    unsafe impl Send for PipeSecurity {}

    impl PipeSecurity {
        fn current_user_only() -> io::Result<Self> {
            // SYSTEM y el propietario del objeto. `D:P` protege la DACL de
            // herencia: otro usuario local no puede abrir el pipe por defecto.
            let sddl = wide("D:P(A;;GA;;;SY)(A;;GA;;;OW)");
            let mut descriptor = null_mut();
            if unsafe {
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    sddl.as_ptr(),
                    SDDL_REVISION_1,
                    &mut descriptor,
                    null_mut(),
                )
            } == 0
            {
                return Err(last_error());
            }
            Ok(Self(descriptor))
        }

        fn attributes(&self) -> SecurityAttributes {
            SecurityAttributes {
                length: std::mem::size_of::<SecurityAttributes>() as u32,
                security_descriptor: self.0,
                inherit_handle: 0,
            }
        }
    }

    impl Drop for PipeSecurity {
        fn drop(&mut self) {
            unsafe { LocalFree(self.0) };
        }
    }

    fn create_instance(name: &[u16], first: bool, security: &PipeSecurity) -> io::Result<File> {
        let open_mode = PIPE_ACCESS_DUPLEX
            | if first {
                FILE_FLAG_FIRST_PIPE_INSTANCE
            } else {
                0
            };
        let attributes = security.attributes();
        let handle = unsafe {
            CreateNamedPipeW(
                name.as_ptr(),
                open_mode,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
                PIPE_UNLIMITED_INSTANCES,
                64 * 1024,
                64 * 1024,
                0,
                (&attributes as *const SecurityAttributes).cast(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(last_error());
        }
        Ok(unsafe { File::from_raw_handle(handle as RawHandle) })
    }

    pub fn connect() -> io::Result<Stream> {
        let name = wide(&crate::ptyd::pipe_name());
        for _ in 0..2 {
            let handle = unsafe {
                CreateFileW(
                    name.as_ptr(),
                    GENERIC_READ | GENERIC_WRITE,
                    0,
                    null(),
                    OPEN_EXISTING,
                    FILE_ATTRIBUTE_NORMAL,
                    null_mut(),
                )
            };
            if handle != INVALID_HANDLE_VALUE {
                return Ok(Stream(unsafe {
                    File::from_raw_handle(handle as RawHandle)
                }));
            }
            if unsafe { GetLastError() } != ERROR_PIPE_BUSY {
                return Err(last_error());
            }
            if unsafe { WaitNamedPipeW(name.as_ptr(), 250) } == 0 {
                return Err(last_error());
            }
        }
        Err(last_error())
    }

    pub fn cleanup_endpoint() {}
}

pub use platform::{cleanup_endpoint, connect, Listener, Stream};
