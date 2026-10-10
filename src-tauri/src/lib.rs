use std::time::Duration;

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_sql::{Migration, MigrationKind};

/// The port the built app is served from in release.
///
/// It must never change: the window's origin is `http://localhost:<port>`, and
/// the Telegram session (IndexedDB) and the `/progressive/*` service worker are
/// both keyed to that origin. A new port would sign everyone out.
const PORT: u16 = 14_327;

/// The tag store. Same shape as the Laravel app's SQLite tables, so a media
/// item is named by its chat id and message id and nothing else.
fn migrations() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            description: "create tags, media_tags and sources",
            sql: r#"
            CREATE TABLE tags (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                created_at TEXT,
                updated_at TEXT
            );

            CREATE TABLE media_tags (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
                chat_id INTEGER NOT NULL,
                message_id INTEGER NOT NULL,
                created_at TEXT,
                updated_at TEXT,
                UNIQUE (tag_id, chat_id, message_id)
            );

            CREATE INDEX media_tags_chat_message ON media_tags (chat_id, message_id);

            CREATE TABLE sources (
                chat_id INTEGER PRIMARY KEY,
                last_seen_message_id INTEGER NOT NULL DEFAULT 0,
                created_at TEXT,
                updated_at TEXT
            );
        "#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "create seen_media",
            // What this account has already opened in the viewer, named the same
            // way as a tag: a chat id and a message id, never the media itself.
            sql: r#"
            CREATE TABLE seen_media (
                chat_id INTEGER NOT NULL,
                message_id INTEGER NOT NULL,
                seen_at TEXT NOT NULL,
                PRIMARY KEY (chat_id, message_id)
            ) WITHOUT ROWID;
        "#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "seed built-in tags",
            // Every library starts with these two, and the app will not delete
            // them (BUILTIN_TAGS in src/lib/media-tags.ts). OR IGNORE keeps a
            // library that already made one by hand as it was.
            sql: r#"
            INSERT OR IGNORE INTO tags (name, created_at, updated_at) VALUES
                ('favorite', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                ('bookmark', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
        "#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "create tag_folders",
            // Folders only group the vocabulary in the tag panel; nothing about
            // tagging media changes. A tag with no folder is "unfiled".
            sql: r#"
            CREATE TABLE tag_folders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                created_at TEXT,
                updated_at TEXT
            );

            ALTER TABLE tags ADD COLUMN folder_id INTEGER REFERENCES tag_folders(id) ON DELETE SET NULL;
        "#,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 5,
            description: "add tags.pinned",
            // A pinned tag sits in the library rail. The built-ins start there.
            sql: r#"
            ALTER TABLE tags ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;

            UPDATE tags SET pinned = 1 WHERE name IN ('favorite', 'bookmark');
        "#,
            kind: MigrationKind::Up,
        },
    ]
}

/// The page shows the main window itself once it is ready, after at least two
/// seconds of splash (src/lib/desktop.ts). If it never does — a crash, a stuck
/// connection — the main window is shown anyway after this.
const SPLASH_MAX: Duration = Duration::from_secs(5);

/// A page in the main window: http://localhost in both dev and release.
fn page(path: &str) -> WebviewUrl {
    if cfg!(debug_assertions) {
        WebviewUrl::App(if path.is_empty() { "index.html" } else { path }.into())
    } else {
        WebviewUrl::External(
            format!("http://localhost:{PORT}/{path}")
                .parse()
                .expect("a valid localhost url"),
        )
    }
}

/// Swap the splash for the main window. Safe to call more than once.
fn reveal(app: &AppHandle) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.set_focus();
    }
    if let Some(splash) = app.get_webview_window("splash") {
        let _ = splash.close();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default().plugin(
        tauri_plugin_sql::Builder::default()
            .add_migrations("sqlite:mediagram.db", migrations())
            .build(),
    );

    // In development the window loads Vite's own http://localhost:3000. A
    // release build serves `dist/` over plain http too, rather than tauri://,
    // because WKWebView only runs service workers on an http(s) origin and
    // video playback streams through one.
    if !cfg!(debug_assertions) {
        builder = builder.plugin(tauri_plugin_localhost::Builder::new(PORT).build());
    }

    builder
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // A small frameless window while the app boots and reaches
            // Telegram; the main window loads hidden behind it and is shown
            // by the page itself once it is ready.
            WebviewWindowBuilder::new(app, "splash", page("splash.html"))
                .title("Mediagram")
                .inner_size(340.0, 380.0)
                .resizable(false)
                .decorations(false)
                .center()
                .skip_taskbar(true)
                .build()?;

            WebviewWindowBuilder::new(app, "main", page(""))
                .title("Mediagram")
                .inner_size(1280.0, 820.0)
                .min_inner_size(720.0, 480.0)
                .resizable(true)
                .visible(false)
                .build()?;

            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(SPLASH_MAX);
                let reveal_handle = handle.clone();
                let _ = handle.run_on_main_thread(move || reveal(&reveal_handle));
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
