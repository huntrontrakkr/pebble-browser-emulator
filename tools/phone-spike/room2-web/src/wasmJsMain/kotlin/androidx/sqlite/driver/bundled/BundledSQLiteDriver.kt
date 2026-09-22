package androidx.sqlite.driver.bundled

import androidx.sqlite.SQLiteConnection
import androidx.sqlite.SQLiteDriver
import androidx.sqlite.SQLiteException
import androidx.sqlite.SQLiteStatement

/**
 * The browser's bundled SQLite: the official SQLite WebAssembly build
 * (`@sqlite.org/sqlite-wasm`), which the page loads and publishes as
 * `globalThis.sqlite3` before the phone starts. Every connection is a private
 * in-memory database called synchronously on the calling thread, so Room 2's
 * blocking statement API works unchanged. The virtual phone is discarded with the
 * session; [open] ignores the file name, and nothing reaches browser storage.
 */
public class BundledSQLiteDriver : SQLiteDriver {
    override fun open(fileName: String): SQLiteConnection = WasmSQLiteConnection(sqlite { openMemory() })
}

private class WasmSQLiteConnection(private val db: JsAny) : SQLiteConnection {
    private var closed = false

    override fun prepare(sql: String): SQLiteStatement {
        check(!closed) { "Connection is closed" }
        return WasmSQLiteStatement(sqlite { dbPrepare(db, sql) })
    }

    override fun inTransaction(): Boolean = !closed && dbInTransaction(db)

    override fun close() {
        if (!closed) {
            closed = true
            dbClose(db)
        }
    }
}

private class WasmSQLiteStatement(private val stmt: JsAny) : SQLiteStatement {
    override fun bindBlob(index: Int, value: ByteArray) = sqlite { stmtBind(stmt, index, value.toUint8Array()) }
    override fun bindDouble(index: Int, value: Double) = sqlite { stmtBindDouble(stmt, index, value) }
    override fun bindLong(index: Int, value: Long) = sqlite { stmtBindLong(stmt, index, value) }
    override fun bindText(index: Int, value: String) = sqlite { stmtBindText(stmt, index, value) }
    override fun bindNull(index: Int) = sqlite { stmtBindNull(stmt, index) }

    override fun getBlob(index: Int): ByteArray = stmtGetBlob(stmt, index)?.toByteArray() ?: ByteArray(0)
    override fun getDouble(index: Int): Double = stmtGetDouble(stmt, index)
    override fun getLong(index: Int): Long = stmtGetLong(stmt, index)
    override fun getText(index: Int): String = stmtGetText(stmt, index) ?: ""
    override fun isNull(index: Int): Boolean = getColumnType(index) == SQLITE_NULL
    override fun getColumnCount(): Int = stmtColumnCount(stmt)
    override fun getColumnName(index: Int): String = stmtColumnName(stmt, index)
    override fun getColumnType(index: Int): Int = stmtColumnType(stmt, index)

    override fun step(): Boolean = sqlite { stmtStep(stmt) }
    override fun reset() = sqlite { stmtReset(stmt) }
    override fun clearBindings() = sqlite { stmtClearBindings(stmt) }
    override fun close() = stmtFinalize(stmt)
}

private const val SQLITE_NULL = 5

/** SQLite reports errors as JavaScript exceptions; Room expects [SQLiteException]. */
private inline fun <T> sqlite(block: () -> T): T =
    try {
        block()
    } catch (e: SQLiteException) {
        throw e
    } catch (e: Throwable) {
        throw SQLiteException(e.message ?: "SQLite error")
    }

private fun ByteArray.toUint8Array(): JsAny {
    val array = newUint8Array(size)
    for (i in indices) setUint8(array, i, this[i].toInt() and 0xff)
    return array
}

private fun JsAny.toByteArray(): ByteArray = ByteArray(uint8Length(this)) { getUint8(this, it).toByte() }

private fun openMemory(): JsAny = js("new globalThis.sqlite3.oo1.DB(':memory:', 'c')")
private fun dbPrepare(db: JsAny, sql: String): JsAny = js("db.prepare(sql)")
private fun dbInTransaction(db: JsAny): Boolean = js("globalThis.sqlite3.capi.sqlite3_get_autocommit(db.pointer) === 0")
private fun dbClose(db: JsAny): Unit = js("db.close()")

private fun stmtBind(stmt: JsAny, index: Int, value: JsAny): Unit = js("{ stmt.bind(index, value); }")
private fun stmtBindDouble(stmt: JsAny, index: Int, value: Double): Unit =
    js("{ stmt.db.checkRc(globalThis.sqlite3.capi.sqlite3_bind_double(stmt.pointer, index, value)); }")
private fun stmtBindLong(stmt: JsAny, index: Int, value: Long): Unit =
    js("{ stmt.db.checkRc(globalThis.sqlite3.capi.sqlite3_bind_int64(stmt.pointer, index, value)); }")
private fun stmtBindText(stmt: JsAny, index: Int, value: String): Unit = js("{ stmt.bind(index, value); }")
private fun stmtBindNull(stmt: JsAny, index: Int): Unit = js("{ stmt.bind(index, null); }")

private fun stmtGetBlob(stmt: JsAny, index: Int): JsAny? = js("stmt.getBlob(index)")
private fun stmtGetDouble(stmt: JsAny, index: Int): Double =
    js("globalThis.sqlite3.capi.sqlite3_column_double(stmt.pointer, index)")
private fun stmtGetLong(stmt: JsAny, index: Int): Long =
    js("globalThis.sqlite3.capi.sqlite3_column_int64(stmt.pointer, index)")
private fun stmtGetText(stmt: JsAny, index: Int): String? = js("stmt.getString(index)")
private fun stmtColumnCount(stmt: JsAny): Int = js("stmt.columnCount")
private fun stmtColumnName(stmt: JsAny, index: Int): String = js("stmt.getColumnName(index)")
private fun stmtColumnType(stmt: JsAny, index: Int): Int =
    js("globalThis.sqlite3.capi.sqlite3_column_type(stmt.pointer, index)")

private fun stmtStep(stmt: JsAny): Boolean = js("stmt.step()")
private fun stmtReset(stmt: JsAny): Unit = js("{ stmt.reset(); }")
private fun stmtClearBindings(stmt: JsAny): Unit = js("{ stmt.clearBindings(); }")
private fun stmtFinalize(stmt: JsAny): Unit = js("{ stmt.finalize(); }")

private fun newUint8Array(size: Int): JsAny = js("new Uint8Array(size)")
private fun setUint8(array: JsAny, index: Int, value: Int): Unit = js("{ array[index] = value; }")
private fun getUint8(array: JsAny, index: Int): Int = js("array[index]")
private fun uint8Length(array: JsAny): Int = js("array.length")
