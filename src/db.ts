// src/db.ts
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

sqlite3.verbose();

export async function openDb() {
    return open<sqlite3.Database, sqlite3.Statement>({
        filename: './data.sqlite',
        driver: sqlite3.Database
    });
}

export async function getDb() {
    const db = await openDb();
    // You can also perform the migration here if needed
    await db.migrate({
        // The 'force' field has been removed for safety
        // Add it back only for development purposes with the correct boolean value
        migrationsPath: './migrations'
    });
    return db;
}