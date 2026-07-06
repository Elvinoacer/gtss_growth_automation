# GTSS Growth Engine Desktop — Data Management Guide

When running the **GTSS Growth Engine Desktop App** (via Electron), production data is not stored in the project's source code folder. Instead, it is stored in your operating system's standard user data directory. This ensures that your database, sessions, and settings survive app updates without being overwritten.

## Absolute Paths by Operating System

The root data folder for the desktop app is `engine-data`, which is located inside the `gtss-growth-desktop` user data directory.

> [!NOTE]
> Replace `<YourUsername>` with your actual system username.

### 🐧 Linux
`/home/<YourUsername>/.config/gtss-growth-desktop/engine-data`

### 🍎 macOS
`/Users/<YourUsername>/Library/Application Support/gtss-growth-desktop/engine-data`

### 🪟 Windows
`C:\Users\<YourUsername>\AppData\Roaming\gtss-growth-desktop\engine-data`

---

## Directory Structure & What It Contains

Inside the `engine-data` folder, you will find the following structure:

- `data/gtss.db`
  - **The SQLite Database**. Contains all your pipelines, leads, history, logs, and settings.
- `.env`
  - **The configuration file**. This is auto-generated during desktop onboarding and holds your `ENCRYPTION_KEY` and other overrides.
- `sessions/`
  - **Browser Profiles**. Contains the persistent Chrome profiles used for LinkedIn, X (Twitter), and Instagram automation. Deleting this logs you out of everything.
- `artifacts/`
  - **Saved Files**. Contains generated images (`gemini-images/`) and other output artifacts.
- `data/browser-locks/`
  - **Concurrency Locks**. Temporary lock files to prevent multiple pipelines from using the same browser profile at the same time.

---

## Common Data Operations

> [!WARNING]
> Always completely close the GTSS Desktop App (and stop `npm run dev`) before performing any of these operations. Modifying files while the server is running can corrupt your database.

### 1. Resetting Everything to "Square 1" (Factory Reset)
If you want a completely fresh install (zero data, zero history, logged out of all accounts), you can delete the entire `engine-data` directory.
When you launch the app again, it will run you through the initial onboarding, generate a new encryption key, and create a fresh, empty database.

**Linux/macOS Command:**
```bash
rm -rf ~/.config/gtss-growth-desktop/engine-data
```
*(On macOS, replace `.config` with `Library/Application Support`)*

### 2. Clearing the Database (Keep Logins & Settings)
If you just want to wipe pipelines and history but keep your social media sessions and encryption key:
1. Navigate to the `engine-data/data/` folder.
2. Delete `gtss.db`, `gtss.db-wal`, and `gtss.db-shm`.
3. Restart the app. The database schema will be automatically rebuilt completely empty.

### 3. Backing Up Your Data
To back up your entire GTSS setup, simply copy the `engine-data` folder to a safe location (e.g., a zip file or cloud drive). Because SQLite is a single file and sessions are just folders, this effectively snapshots your entire workspace.

### 4. Moving Data to a Different Computer
1. Install and run GTSS on the new computer once (so it creates the initial folders), then close it.
2. Copy your backed-up `engine-data` folder from the old computer.
3. Replace the `engine-data` folder on the new computer with your backup.
4. Launch the app. All your pipelines, history, and active browser sessions will be exactly as you left them.

> [!IMPORTANT]
> Because passwords and cookies in the `sessions/` folder are sometimes tied to hardware encryption (especially on macOS Keychain or Windows DPAPI), you *may* be required to re-login to LinkedIn/X/IG on the new computer even if you copied the session folder. The database and history, however, will migrate perfectly.
