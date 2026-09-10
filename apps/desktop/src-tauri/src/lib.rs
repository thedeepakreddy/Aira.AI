/// Aira desktop shell.
///
/// The shell deliberately holds no product logic and no credentials. It hosts
/// the same single-page app the web build serves, which talks to the Aira
/// gateway over HTTPS. Provider API keys live in the gateway alone — a packaged
/// .app can be unzipped and read, so anything embedded here would be public.
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("failed to start Aira");
}
