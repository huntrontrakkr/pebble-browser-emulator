package io.rebble.libpebblecommon.util

import kotlinx.io.buffered
import kotlinx.io.files.SystemFileSystem as KotlinxFiles
import kotlinx.io.readByteArray
import okio.Buffer
import okio.FileHandle
import okio.FileMetadata
import okio.FileNotFoundException
import okio.FileSystem
import okio.IOException
import okio.Path
import okio.Path.Companion.toPath
import okio.Sink
import okio.Source
import okio.Timeout
import okio.fakefilesystem.FakeFileSystem
import kotlinx.io.files.Path as KotlinxPath

/**
 * The browser phone's files live in memory and are discarded with the session, like
 * its database. Upstream reaches them through both kotlinx-io and Okio, so Okio's
 * system file system here is a view of kotlinx-io's (the browser build of kotlinx-io,
 * tools/phone-spike/kotlinxio-web): one tree, whichever library a file goes through.
 */
private val system: FileSystem = KotlinxIoFileSystem()

internal actual val FileSystem.Companion.SYSTEM: FileSystem
    get() = system

/**
 * Okio's file system API over kotlinx-io's. Whole-file reads and writes suit the
 * phone's files (app bundles, caches). Random access, and symlinks, are not
 * supported and say so.
 */
private class KotlinxIoFileSystem : FileSystem() {
    private fun Path.kotlinx() = KotlinxPath(toString())

    override fun canonicalize(path: Path): Path {
        if (!KotlinxFiles.exists(path.kotlinx())) throw FileNotFoundException("no such file: $path")
        return KotlinxFiles.resolve(path.kotlinx()).toString().toPath()
    }

    override fun metadataOrNull(path: Path): FileMetadata? =
        KotlinxFiles.metadataOrNull(path.kotlinx())?.let {
            FileMetadata(
                isRegularFile = it.isRegularFile,
                isDirectory = it.isDirectory,
                size = if (it.isRegularFile) it.size else null,
            )
        }

    override fun list(dir: Path): List<Path> = listOrNull(dir) ?: throw FileNotFoundException("no such directory: $dir")

    override fun listOrNull(dir: Path): List<Path>? {
        val metadata = KotlinxFiles.metadataOrNull(dir.kotlinx()) ?: return null
        if (!metadata.isDirectory) return null
        return KotlinxFiles.list(dir.kotlinx()).map { dir / it.name }.sorted()
    }

    override fun openReadOnly(file: Path): FileHandle =
        throw IOException("Random access is not supported by the browser phone's files: $file")

    override fun openReadWrite(file: Path, mustCreate: Boolean, mustExist: Boolean): FileHandle =
        throw IOException("Random access is not supported by the browser phone's files: $file")

    override fun source(file: Path): Source {
        val bytes = KotlinxFiles.source(file.kotlinx()).buffered().use { it.readByteArray() }
        return Buffer().write(bytes)
    }

    override fun sink(file: Path, mustCreate: Boolean): Sink {
        if (mustCreate && KotlinxFiles.exists(file.kotlinx())) throw IOException("$file already exists.")
        return KotlinxSink(file.kotlinx(), append = false)
    }

    override fun appendingSink(file: Path, mustExist: Boolean): Sink {
        if (mustExist && !KotlinxFiles.exists(file.kotlinx())) throw IOException("$file doesn't exist.")
        return KotlinxSink(file.kotlinx(), append = true)
    }

    override fun createDirectory(dir: Path, mustCreate: Boolean) {
        val metadata = KotlinxFiles.metadataOrNull(dir.kotlinx())
        if (metadata != null) {
            if (mustCreate || !metadata.isDirectory) throw IOException("$dir already exists.")
            return
        }
        val parent = dir.parent
        if (parent != null && KotlinxFiles.metadataOrNull(parent.kotlinx())?.isDirectory != true)
            throw IOException("parent directory does not exist: $parent")
        KotlinxFiles.createDirectories(dir.kotlinx())
    }

    override fun atomicMove(source: Path, target: Path) = KotlinxFiles.atomicMove(source.kotlinx(), target.kotlinx())

    override fun delete(path: Path, mustExist: Boolean) = KotlinxFiles.delete(path.kotlinx(), mustExist)

    override fun createSymlink(source: Path, target: Path): Unit =
        throw IOException("Symlinks are not supported by the browser phone's files")
}

/** Writes through to kotlinx-io as each buffer arrives. */
private class KotlinxSink(path: KotlinxPath, append: Boolean) : Sink {
    private val sink = KotlinxFiles.sink(path, append)

    override fun write(source: Buffer, byteCount: Long) {
        val bytes = source.readByteArray(byteCount)
        sink.write(kotlinx.io.Buffer().apply { write(bytes) }, bytes.size.toLong())
    }

    override fun flush() = sink.flush()

    override fun timeout(): Timeout = Timeout.NONE

    override fun close() = sink.close()
}

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
