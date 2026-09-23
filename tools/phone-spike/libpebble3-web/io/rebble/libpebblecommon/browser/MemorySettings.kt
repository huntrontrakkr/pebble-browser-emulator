package io.rebble.libpebblecommon.browser

import com.russhwolf.settings.Settings

/**
 * Settings held in memory for the session. The phone is thrown away with the page, and
 * the library's default browser settings (`localStorage`) would both persist and fail in
 * a worker, which has no `localStorage`.
 */
internal class MemorySettings : Settings {
    private val values = mutableMapOf<String, Any>()

    override val keys: Set<String> get() = values.keys.toSet()
    override val size: Int get() = values.size
    override fun clear() = values.clear()
    override fun remove(key: String) {
        values.remove(key)
    }
    override fun hasKey(key: String): Boolean = key in values

    override fun putInt(key: String, value: Int) = values.set(key, value)
    override fun getInt(key: String, defaultValue: Int): Int = getIntOrNull(key) ?: defaultValue
    override fun getIntOrNull(key: String): Int? = values[key] as? Int

    override fun putLong(key: String, value: Long) = values.set(key, value)
    override fun getLong(key: String, defaultValue: Long): Long = getLongOrNull(key) ?: defaultValue
    override fun getLongOrNull(key: String): Long? = values[key] as? Long

    override fun putString(key: String, value: String) = values.set(key, value)
    override fun getString(key: String, defaultValue: String): String = getStringOrNull(key) ?: defaultValue
    override fun getStringOrNull(key: String): String? = values[key] as? String

    override fun putFloat(key: String, value: Float) = values.set(key, value)
    override fun getFloat(key: String, defaultValue: Float): Float = getFloatOrNull(key) ?: defaultValue
    override fun getFloatOrNull(key: String): Float? = values[key] as? Float

    override fun putDouble(key: String, value: Double) = values.set(key, value)
    override fun getDouble(key: String, defaultValue: Double): Double = getDoubleOrNull(key) ?: defaultValue
    override fun getDoubleOrNull(key: String): Double? = values[key] as? Double

    override fun putBoolean(key: String, value: Boolean) = values.set(key, value)
    override fun getBoolean(key: String, defaultValue: Boolean): Boolean = getBooleanOrNull(key) ?: defaultValue
    override fun getBooleanOrNull(key: String): Boolean? = values[key] as? Boolean
}
