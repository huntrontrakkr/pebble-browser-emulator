package io.rebble.libpebblecommon.util

/**
 * The browser's DataBuffer: a fixed-size byte array with one position, big-endian
 * unless set otherwise, behaving like the java.nio.ByteBuffer the desktop and Android
 * versions wrap. Reading or writing past the end fails, as ByteBuffer does.
 */
actual class DataBuffer {
    private val bytes: ByteArray
    private var position = 0
    private var littleEndian = false

    actual constructor(size: Int) {
        bytes = ByteArray(size)
    }

    actual constructor(bytes: UByteArray) {
        this.bytes = bytes.toByteArray()
    }

    actual val length: Int get() = bytes.size
    actual val readPosition: Int get() = position
    actual val remaining: Int get() = bytes.size - position

    private fun take(count: Int): Int {
        if (count > remaining) throw IndexOutOfBoundsException("DataBuffer: $count bytes at $position of ${bytes.size}")
        return position.also { position += count }
    }

    private fun write(value: Long, size: Int) {
        val at = take(size)
        for (i in 0 until size) {
            val shift = 8 * if (littleEndian) i else size - 1 - i
            bytes[at + i] = (value ushr shift).toByte()
        }
    }

    private fun read(size: Int): Long {
        val at = take(size)
        var value = 0L
        for (i in 0 until size) {
            val shift = 8 * if (littleEndian) i else size - 1 - i
            value = value or ((bytes[at + i].toLong() and 0xff) shl shift)
        }
        return value
    }

    actual fun putUShort(short: UShort) = write(short.toLong(), 2)
    actual fun getUShort(): UShort = read(2).toUShort()
    actual fun putShort(short: Short) = write(short.toLong(), 2)
    actual fun getShort(): Short = read(2).toShort()
    actual fun putUByte(byte: UByte) = write(byte.toLong(), 1)
    actual fun getUByte(): UByte = read(1).toUByte()
    actual fun putByte(byte: Byte) = write(byte.toLong(), 1)
    actual fun getByte(): Byte = read(1).toByte()

    actual fun putBytes(bytes: UByteArray) {
        val at = take(bytes.size)
        bytes.asByteArray().copyInto(this.bytes, at)
    }

    actual fun getBytes(count: Int): UByteArray {
        val at = take(count)
        return bytes.copyOfRange(at, at + count).asUByteArray()
    }

    actual fun putUInt(uint: UInt) = write(uint.toLong(), 4)
    actual fun getUInt(): UInt = read(4).toUInt()
    actual fun putInt(int: Int) = write(int.toLong(), 4)
    actual fun getInt(): Int = read(4).toInt()
    actual fun putULong(ulong: ULong) = write(ulong.toLong(), 8)
    actual fun getULong(): ULong = read(8).toULong()

    actual fun array(): UByteArray = bytes.copyOf().asUByteArray()

    actual fun setEndian(endian: Endian) {
        littleEndian = endian == Endian.Little
    }

    actual fun rewind() {
        position = 0
    }
}
