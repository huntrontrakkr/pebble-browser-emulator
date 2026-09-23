package kotlinx.io.files

import kotlinx.io.Buffer
import kotlinx.io.IOException
import kotlinx.io.RawSink
import kotlinx.io.RawSource
import kotlinx.io.readByteArray

// kotlinx.io.files for the browser phone: a POSIX file tree in memory, discarded with
// the session. It follows the released Node backend's behaviour (errors, directory
// creation, listing) without Node's `fs`, `path` and `os` modules, which a page lacks.
// Relative paths resolve against "/", the phone's only directory tree.

public actual class Path internal constructor(
    rawPath: String,
    @Suppress("UNUSED_PARAMETER") any: Any?,
) {
    internal val path: String = removeTrailingSeparators(rawPath)

    public actual val parent: Path?
        get() {
            if (path.isEmpty() || !path.contains(SystemPathSeparator)) return null
            val p = dirname(path)
            return when {
                p.isEmpty() -> null
                p == path -> null
                else -> Path(p)
            }
        }

    public actual val isAbsolute: Boolean
        get() = path.startsWith(SystemPathSeparator)

    public actual val name: String
        get() = if (path.isEmpty()) "" else path.substringAfterLast(SystemPathSeparator)

    public actual override fun toString(): String = path

    actual override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is Path) return false
        return path == other.path
    }

    actual override fun hashCode(): Int = path.hashCode()
}

/** As Node's `path.dirname` for POSIX paths. */
private fun dirname(path: String): String {
    val index = path.lastIndexOf('/')
    return when {
        index < 0 -> "."
        index == 0 -> "/"
        else -> path.substring(0, index)
    }
}

public actual val SystemPathSeparator: Char = '/'

public actual fun Path(path: String): Path = Path(path, null)

public actual val SystemTemporaryDirectory: Path = Path("/tmp")

public actual open class FileNotFoundException actual constructor(
    message: String?,
) : IOException(message)

/** The session's files: absolute path to contents, plus the directories. */
private object MemoryTree {
    val files = mutableMapOf<String, ByteArray>()
    val directories = mutableSetOf("/")

    fun key(path: Path): String {
        val absolute = if (path.isAbsolute) path.path else "/" + path.path
        val parts = mutableListOf<String>()
        for (part in absolute.split('/')) {
            when (part) {
                "", "." -> Unit
                ".." -> if (parts.isNotEmpty()) parts.removeAt(parts.size - 1)
                else -> parts.add(part)
            }
        }
        return "/" + parts.joinToString("/")
    }

    fun parentKey(key: String): String? = if (key == "/") null else dirname(key)

    fun children(key: String): List<String> {
        val prefix = if (key == "/") "/" else "$key/"
        return (files.keys + directories)
            .filter { it != key && it.startsWith(prefix) && !it.substring(prefix.length).contains('/') }
            .sorted()
    }
}

public actual val SystemFileSystem: FileSystem = object : SystemFileSystemImpl() {
    override fun exists(path: Path): Boolean {
        val key = MemoryTree.key(path)
        return key in MemoryTree.files || key in MemoryTree.directories
    }

    override fun delete(path: Path, mustExist: Boolean) {
        val key = MemoryTree.key(path)
        when {
            key in MemoryTree.files -> MemoryTree.files.remove(key)
            key in MemoryTree.directories -> {
                if (MemoryTree.children(key).isNotEmpty()) throw IOException("Delete failed for $path: directory is not empty")
                if (key == "/") throw IOException("Delete failed for $path")
                MemoryTree.directories.remove(key)
            }
            mustExist -> throw FileNotFoundException("File does not exist: $path")
        }
    }

    override fun createDirectories(path: Path, mustCreate: Boolean) {
        val metadata = metadataOrNull(path)
        if (metadata != null) {
            if (mustCreate) throw IOException("Path already exists: $path")
            if (metadata.isRegularFile) throw IOException("Path already exists and it's a file: $path")
            return
        }
        var key: String? = MemoryTree.key(path)
        val missing = mutableListOf<String>()
        while (key != null && key !in MemoryTree.directories) {
            if (key in MemoryTree.files) throw IOException("Path already exists and it's a file: $key")
            missing.add(key)
            key = MemoryTree.parentKey(key)
        }
        MemoryTree.directories.addAll(missing)
    }

    override fun atomicMove(source: Path, destination: Path) {
        if (!exists(source)) throw FileNotFoundException("Source does not exist: ${source.path}")
        val from = MemoryTree.key(source)
        val to = MemoryTree.key(destination)
        if (from == to) return
        val parent = MemoryTree.parentKey(to)
        if (parent != null && parent !in MemoryTree.directories)
            throw IOException("Move failed from $source to $destination: no directory $parent")
        MemoryTree.files.remove(from)?.let {
            if (to in MemoryTree.directories) throw IOException("Move failed from $source to $destination: target is a directory")
            MemoryTree.files[to] = it
            return
        }
        if (to in MemoryTree.files || (to in MemoryTree.directories && MemoryTree.children(to).isNotEmpty()))
            throw IOException("Move failed from $source to $destination: target exists")
        val prefix = "$from/"
        val moved = MemoryTree.files.keys.filter { it.startsWith(prefix) }
        for (key in moved) MemoryTree.files[to + key.substring(from.length)] = MemoryTree.files.remove(key)!!
        val dirs = MemoryTree.directories.filter { it == from || it.startsWith(prefix) }
        MemoryTree.directories.removeAll(dirs.toSet())
        MemoryTree.directories.addAll(dirs.map { to + it.substring(from.length) })
    }

    override fun metadataOrNull(path: Path): FileMetadata? {
        val key = MemoryTree.key(path)
        MemoryTree.files[key]?.let { return FileMetadata(isRegularFile = true, isDirectory = false, it.size.toLong()) }
        if (key in MemoryTree.directories) return FileMetadata(isRegularFile = false, isDirectory = true, -1L)
        return null
    }

    override fun source(path: Path): RawSource {
        val key = MemoryTree.key(path)
        if (key in MemoryTree.directories) throw IOException("Failed to open a file ${path.path}: it is a directory.")
        val contents = MemoryTree.files[key] ?: throw FileNotFoundException("File does not exist: ${path.path}")
        return MemorySource(contents)
    }

    override fun sink(path: Path, append: Boolean): RawSink {
        val key = MemoryTree.key(path)
        if (key in MemoryTree.directories) throw IOException("Failed to open a file ${path.path}: it is a directory.")
        val parent = MemoryTree.parentKey(key)
        if (parent != null && parent !in MemoryTree.directories)
            throw IOException("Failed to open a file ${path.path}: no directory $parent.")
        val existing = if (append) MemoryTree.files[key] ?: ByteArray(0) else ByteArray(0)
        MemoryTree.files[key] = existing
        return MemorySink(key, existing)
    }

    override fun resolve(path: Path): Path {
        if (!exists(path)) throw FileNotFoundException(path.path)
        return Path(MemoryTree.key(path))
    }

    override fun list(directory: Path): Collection<Path> {
        val metadata = metadataOrNull(directory) ?: throw FileNotFoundException(directory.path)
        if (!metadata.isDirectory) throw IOException("Not a directory: ${directory.path}")
        return MemoryTree.children(MemoryTree.key(directory)).map { Path(directory, it.substringAfterLast('/')) }
    }
}

/** Reads a snapshot of the file taken when it was opened. */
private class MemorySource(private val contents: ByteArray) : RawSource {
    private var offset = 0
    private var closed = false

    override fun readAtMostTo(sink: Buffer, byteCount: Long): Long {
        check(!closed) { "Source is closed." }
        require(byteCount >= 0) { "byteCount: $byteCount" }
        if (byteCount == 0L) return 0
        if (offset >= contents.size) return -1L
        val count = minOf(byteCount, (contents.size - offset).toLong()).toInt()
        sink.write(contents, offset, offset + count)
        offset += count
        return count.toLong()
    }

    override fun close() {
        closed = true
    }
}

/** Each write lands in the tree at once, as a Node file write does. */
private class MemorySink(private val key: String, initial: ByteArray) : RawSink {
    private var contents = initial
    private var closed = false

    override fun write(source: Buffer, byteCount: Long) {
        check(!closed) { "Sink is closed." }
        require(byteCount >= 0) { "byteCount: $byteCount" }
        if (byteCount == 0L) return
        val bytes = source.readByteArray(minOf(byteCount, source.size).toInt())
        contents += bytes
        MemoryTree.files[key] = contents
    }

    override fun flush() = Unit

    override fun close() {
        closed = true
    }
}
