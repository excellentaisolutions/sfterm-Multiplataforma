// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
  // MODO DAEMON: el mismo ejecutable, sin GUI. Es lo que mantiene vivos los
  // PTYs (y con ellos las conversaciones) cuando la app se reinstala o se
  // relanza. Se sale ANTES de tocar Tauri/AppKit, asi que no hay ventana, no
  // hay icono en el Dock y no entra al plugin de instancia unica.
  if std::env::args().any(|a| a == "--ptyd") {
    app_lib::ptyd::server::run();
    return;
  }
  app_lib::run();
}
