import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.resolve(__dirname, '../../telemetry.db');

let dbPromise = null;

export async function initTelemetryDB() {
    if (dbPromise) return dbPromise;

    dbPromise = open({
        filename: dbPath,
        driver: sqlite3.cached.Database
    }).then(async (db) => {
        // Habilitar WAL para alto rendimiento y concurrencia con Python
        await db.exec('PRAGMA journal_mode = WAL;');
        
        await db.exec(`
            CREATE TABLE IF NOT EXISTS api_telemetry (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                system TEXT NOT NULL,
                method TEXT NOT NULL,
                endpoint TEXT NOT NULL,
                status_code INTEGER NOT NULL,
                duration_ms INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_telemetry_endpoint ON api_telemetry(endpoint);
            CREATE INDEX IF NOT EXISTS idx_telemetry_time ON api_telemetry(timestamp);
        `);
        return db;
    }).catch(err => {
        console.error("❌ Error inicializando Telemetry DB:", err);
        return null;
    });

    return dbPromise;
}

export async function logApiTelemetry(system, method, fullUrl, statusCode, durationMs) {
    try {
        const db = await initTelemetryDB();
        if (!db) return;

        // Extraer solo la ruta del endpoint para no llenar la base de datos con URLs completas o Query Params irrelevantes
        let endpoint = fullUrl;
        try {
            const parsed = new URL(fullUrl);
            endpoint = parsed.pathname;
        } catch(e) {}

        // Fire and forget insert
        db.run(
            `INSERT INTO api_telemetry (system, method, endpoint, status_code, duration_ms) VALUES (?, ?, ?, ?, ?)`,
            [system, method.toUpperCase(), endpoint, statusCode, durationMs]
        ).catch(err => console.error("⚠️ Error escribiendo telemetría:", err.message));
    } catch (err) {
        console.error("⚠️ Fallo silencioso al registrar telemetría:", err.message);
    }
}
