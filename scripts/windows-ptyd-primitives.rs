#![allow(dead_code, unused_imports)]

use std::io::{Read, Write};

mod ptyd {
    pub fn pipe_name() -> String {
        format!(r"\\.\pipe\sfterm-primitives-{}", std::process::id())
    }

    pub mod transport {
        include!(r"../src-tauri/src/ptyd/transport.rs");
    }

    pub mod job {
        include!(r"../src-tauri/src/ptyd/job.rs");
    }
}

fn named_pipe_roundtrip() {
    let listener = ptyd::transport::Listener::bind().expect("crear Named Pipe");
    let server = std::thread::spawn(move || {
        let mut stream = listener.accept().expect("aceptar cliente");
        let mut input = [0u8; 4];
        stream.read_exact(&mut input).expect("leer ping");
        assert_eq!(&input, b"ping");
        stream.write_all(b"pong").expect("escribir pong");
    });

    let mut client = ptyd::transport::connect().expect("conectar Named Pipe");
    client.write_all(b"ping").expect("escribir ping");
    let mut output = [0u8; 4];
    client.read_exact(&mut output).expect("leer pong");
    assert_eq!(&output, b"pong");
    server.join().expect("servidor Named Pipe");
}

fn job_object_terminates_process() {
    use std::os::windows::process::CommandExt;

    let mut child = std::process::Command::new("cmd.exe")
        .args(["/d", "/s", "/c", "ping 127.0.0.1 -n 30 > nul"])
        .creation_flags(0x0800_0000)
        .spawn()
        .expect("crear proceso de prueba");
    let job = ptyd::job::Job::assign(child.id()).expect("asignar Job Object");
    job.terminate().expect("terminar Job Object");
    assert!(!child.wait().expect("esperar proceso").success());
}

fn main() {
    named_pipe_roundtrip();
    job_object_terminates_process();
    println!("Windows PTY daemon primitives: OK");
}
