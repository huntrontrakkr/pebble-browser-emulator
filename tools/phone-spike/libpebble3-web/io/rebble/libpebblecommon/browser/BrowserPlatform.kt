package io.rebble.libpebblecommon.browser

import androidx.compose.ui.graphics.ImageBitmap
import io.rebble.libpebblecommon.calendar.CalendarEvent
import io.rebble.libpebblecommon.calendar.NewCalendarEvent
import io.rebble.libpebblecommon.calendar.PlatformCalendarActionHandler
import io.rebble.libpebblecommon.calendar.SystemCalendar
import io.rebble.libpebblecommon.calls.Call
import io.rebble.libpebblecommon.calls.LegacyPhoneReceiver
import io.rebble.libpebblecommon.calls.MissedCall
import io.rebble.libpebblecommon.calls.SystemCallLog
import io.rebble.libpebblecommon.connection.LibPebble
import io.rebble.libpebblecommon.connection.OtherPebbleApp
import io.rebble.libpebblecommon.connection.OtherPebbleApps
import io.rebble.libpebblecommon.connection.endpointmanager.timeline.PlatformNotificationActionHandler
import io.rebble.libpebblecommon.contacts.SystemContact
import io.rebble.libpebblecommon.contacts.SystemContacts
import io.rebble.libpebblecommon.database.entity.BaseAction
import io.rebble.libpebblecommon.database.entity.CalendarEntity
import io.rebble.libpebblecommon.database.entity.TimelinePin
import io.rebble.libpebblecommon.imaging.EncodedImage
import io.rebble.libpebblecommon.music.PlaybackStatus
import io.rebble.libpebblecommon.music.SystemMusicControl
import io.rebble.libpebblecommon.notification.NotificationAppsSync
import io.rebble.libpebblecommon.notification.NotificationListenerConnection
import io.rebble.libpebblecommon.packets.blobdb.TimelineIcon
import io.rebble.libpebblecommon.packets.blobdb.TimelineItem
import io.rebble.libpebblecommon.services.blobdb.TimelineActionResult
import io.rebble.libpebblecommon.util.GeolocationPositionResult
import io.rebble.libpebblecommon.util.SystemGeolocation
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.flow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.time.Clock
import kotlin.time.Duration
import kotlin.time.Instant
import kotlin.uuid.Uuid

// The browser phone's operating system services. It is a disposable fixture with no
// calendar, call log, contacts, music player or location of its own, so each service
// reports what an Android phone without those permissions or apps reports: nothing, and
// no permission. Nothing here invents data. The virtual phone's inputs (notifications,
// location, weather) replace these one at a time, each behind its own acceptance gate.

private fun unsupported(what: String) =
    TimelineActionResult(success = false, icon = TimelineIcon.ResultFailed, title = "Unsupported: $what")

/** Notifications reach the browser phone through the Android notification shim (later). */
internal class BrowserNotificationListenerConnection : NotificationListenerConnection {
    override fun init(libPebble: LibPebble) = Unit
}

internal class BrowserNotificationAppsSync : NotificationAppsSync {
    override fun init() = Unit
}

internal class BrowserNotificationActionHandler : PlatformNotificationActionHandler {
    override suspend fun invoke(
        itemId: Uuid,
        action: BaseAction,
        attributes: List<TimelineItem.Attribute>,
    ): TimelineActionResult = unsupported("notification action")
}

internal class BrowserSystemCalendar : SystemCalendar {
    override suspend fun getCalendars(): List<CalendarEntity> = emptyList()
    override suspend fun getCalendarEvents(calendar: CalendarEntity, startDate: Instant, endDate: Instant): List<CalendarEvent> =
        emptyList()
    override suspend fun enableSyncForCalendar(calendar: CalendarEntity) = Unit
    override fun registerForCalendarChanges(): Flow<Unit>? = null
    override fun hasPermission(): Boolean = false
    override suspend fun createEvent(event: NewCalendarEvent): String? = null
    override fun supportsPinActions(): Boolean = false
}

internal class BrowserCalendarActionHandler : PlatformCalendarActionHandler {
    override suspend fun invoke(pin: TimelinePin, action: BaseAction): TimelineActionResult = unsupported("calendar action")
}

internal class BrowserSystemCallLog : SystemCallLog {
    override suspend fun getMissedCalls(start: Instant): List<MissedCall> = emptyList()
    override fun registerForMissedCallChanges(): Flow<Unit> = emptyFlow()
    override fun hasPermission(): Boolean = false
}

internal class BrowserLegacyPhoneReceiver : LegacyPhoneReceiver {
    override fun init(currentCall: MutableStateFlow<Call?>) = Unit
}

/** No media player: nothing is playing, so the watch's controls have nothing to act on. */
internal class BrowserSystemMusicControl : SystemMusicControl {
    override fun play() = Unit
    override fun pause() = Unit
    override fun playPause() = Unit
    override fun nextTrack() = Unit
    override fun previousTrack() = Unit
    override fun volumeDown() = Unit
    override fun volumeUp() = Unit
    override val playbackState: StateFlow<PlaybackStatus?> = MutableStateFlow(null)
    override val supportsAlbumArt: Boolean = false
    override suspend fun getAlbumArt(title: String, artist: String, width: Int, height: Int): EncodedImage? = null
    override val albumArtUpdated: Flow<Unit> = emptyFlow()
}

/**
 * The phone's position is the session's location setting, as for the built-in phone: the
 * page supplies it (`pebblePhoneHost.location`, JSON with latitude, longitude and the
 * optional accuracy, altitude, heading and speed), or nothing when location is off, which
 * apps see as an error.
 */
internal class BrowserSystemGeolocation : SystemGeolocation {
    private fun current(): GeolocationPositionResult {
        val json = hostLocation() ?: return GeolocationPositionResult.Error("Location is off in this session")
        val position = Json.parseToJsonElement(json).jsonObject
        fun value(key: String) = position[key]?.jsonPrimitive?.doubleOrNull
        val latitude = value("latitude") ?: return GeolocationPositionResult.Error("No latitude")
        val longitude = value("longitude") ?: return GeolocationPositionResult.Error("No longitude")
        return GeolocationPositionResult.Success(
            Clock.System.now(), latitude, longitude,
            value("accuracy"), value("altitude"), value("heading"), value("speed"),
        )
    }

    override suspend fun getCurrentPosition(maximumAge: Duration?, timeout: Duration?, highAccuracy: Boolean) = current()

    override suspend fun watchPosition(interval: Duration, highAccuracy: Boolean): Flow<GeolocationPositionResult> = flow {
        while (true) {
            emit(current())
            delay(interval)
        }
    }
}

private fun hostLocation(): String? =
    js("(globalThis.pebblePhoneHost && globalThis.pebblePhoneHost.location) ? globalThis.pebblePhoneHost.location() : null")

internal class BrowserOtherPebbleApps : OtherPebbleApps {
    private val none = MutableStateFlow<List<OtherPebbleApp>>(emptyList())
    override fun otherPebbleCompanionAppsInstalled(): StateFlow<List<OtherPebbleApp>> = none
}

internal class BrowserSystemContacts : SystemContacts {
    override fun registerForContactsChanges(): Flow<Unit> = emptyFlow()
    override suspend fun getContacts(): List<SystemContact> = emptyList()
    override fun hasPermission(): Boolean = false
    override suspend fun getContactImage(lookupKey: String): ImageBitmap? = null
}
