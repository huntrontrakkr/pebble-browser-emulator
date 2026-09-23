package io.rebble.libpebblecommon.util

import okio.FileSystem
import okio.Path
import okio.Path.Companion.toPath
import okio.fakefilesystem.FakeFileSystem

/**
 * The browser phone's files live in memory and are discarded with the session, like
 * its database. Okio's FakeFileSystem is its reference in-memory implementation.
 */
private val memory = FakeFileSystem()

internal actual val FileSystem.Companion.SYSTEM: FileSystem
    get() = memory

/**
 * Reads the archive into a separate in-memory file system: the central directory is
 * parsed here, and deflated entries are inflated synchronously by fflate (the archive
 * library the emulator already ships, published as `globalThis.fflate` before the
 * phone starts). App bundles are small, so eager extraction is simple and bounded.
 * Zip64 and encrypted entries are rejected rather than misread.
 */
internal actual fun FileSystem.openZip(zipPath: Path): FileSystem {
    val zip = read(zipPath) { readByteArray() }
    val files = FakeFileSystem()
    for (entry in ZipDirectory(zip).entries()) {
        val path = "/".toPath() / entry.name
        if (entry.name.endsWith("/")) {
            files.createDirectories(path)
            continue
        }
        path.parent?.let { files.createDirectories(it) }
        files.write(path) { write(entry.contents(zip)) }
    }
    return files
}

private class ZipEntry(val name: String, val method: Int, val flags: Int, val compressedSize: Int, val size: Int, val localOffset: Int) {
    fun contents(zip: ByteArray): ByteArray {
        require(flags and 1 == 0) { "Encrypted zip entry $name is not supported" }
        require(zip.u32(localOffset) == 0x04034b50L) { "Bad local header for $name" }
        val start = localOffset + 30 + zip.u16(localOffset + 26) + zip.u16(localOffset + 28)
        val data = zip.copyOfRange(start, start + compressedSize)
        return when (method) {
            0 -> data
            8 -> inflateRaw(data, size)
            else -> error("Zip compression method $method for $name is not supported")
        }
    }
}

private class ZipDirectory(private val zip: ByteArray) {
    fun entries(): List<ZipEntry> {
        val end = (zip.size - 22 downTo maxOf(0, zip.size - 22 - 0xffff))
            .firstOrNull { zip.u32(it) == 0x06054b50L } ?: error("Not a zip archive")
        val count = zip.u16(end + 10)
        var offset = zip.u32(end + 16).toInt()
        require(count != 0xffff && offset != -1) { "Zip64 archives are not supported" }
        return List(count) {
            require(zip.u32(offset) == 0x02014b50L) { "Bad central directory entry" }
            val nameLength = zip.u16(offset + 28)
            val entry = ZipEntry(
                name = zip.decodeToString(offset + 46, offset + 46 + nameLength),
                method = zip.u16(offset + 10),
                flags = zip.u16(offset + 8),
                compressedSize = zip.u32(offset + 20).toInt(),
                size = zip.u32(offset + 24).toInt(),
                localOffset = zip.u32(offset + 42).toInt(),
            )
            offset += 46 + nameLength + zip.u16(offset + 30) + zip.u16(offset + 32)
            entry
        }
    }
}

private fun ByteArray.u16(at: Int): Int = (this[at].toInt() and 0xff) or ((this[at + 1].toInt() and 0xff) shl 8)

private fun ByteArray.u32(at: Int): Long = u16(at).toLong() or (u16(at + 2).toLong() shl 16)

private fun inflateRaw(data: ByteArray, size: Int): ByteArray {
    val input = newUint8Array(data.size)
    for (i in data.indices) setUint8(input, i, data[i].toInt() and 0xff)
    val output = fflateInflate(input, size)
    return ByteArray(uint8Length(output)) { getUint8(output, it).toByte() }
}

private fun fflateInflate(data: JsAny, size: Int): JsAny =
    js("globalThis.fflate.inflateSync(data, { out: new Uint8Array(size) })")
private fun newUint8Array(size: Int): JsAny = js("new Uint8Array(size)")
private fun setUint8(array: JsAny, index: Int, value: Int): Unit = js("{ array[index] = value; }")
private fun getUint8(array: JsAny, index: Int): Int = js("array[index]")
private fun uint8Length(array: JsAny): Int = js("array.length")
