package io.rebble.libpebblecommon.di

import io.rebble.libpebblecommon.browser.BrowserCalendarActionHandler
import io.rebble.libpebblecommon.browser.BrowserLegacyPhoneReceiver
import io.rebble.libpebblecommon.browser.BrowserNotificationActionHandler
import io.rebble.libpebblecommon.browser.BrowserNotificationAppsSync
import io.rebble.libpebblecommon.browser.BrowserNotificationListenerConnection
import io.rebble.libpebblecommon.browser.BrowserOtherPebbleApps
import io.rebble.libpebblecommon.browser.BrowserSystemCalendar
import io.rebble.libpebblecommon.browser.BrowserSystemCallLog
import io.rebble.libpebblecommon.browser.BrowserSystemContacts
import io.rebble.libpebblecommon.browser.BrowserSystemGeolocation
import io.rebble.libpebblecommon.browser.BrowserSystemMusicControl
import io.rebble.libpebblecommon.calendar.PlatformCalendarActionHandler
import io.rebble.libpebblecommon.calendar.SystemCalendar
import io.rebble.libpebblecommon.calls.LegacyPhoneReceiver
import io.rebble.libpebblecommon.calls.SystemCallLog
import io.rebble.libpebblecommon.connection.OtherPebbleApps
import io.rebble.libpebblecommon.connection.PhoneCapabilities
import io.rebble.libpebblecommon.connection.PlatformFlags
import io.rebble.libpebblecommon.connection.bt.ble.BlePlatformConfig
import io.rebble.libpebblecommon.connection.bt.classic.transport.ClassicScanner
import io.rebble.libpebblecommon.connection.bt.classic.transport.JvmClassicScanner
import io.rebble.libpebblecommon.connection.endpointmanager.timeline.PlatformNotificationActionHandler
import io.rebble.libpebblecommon.contacts.SystemContacts
import io.rebble.libpebblecommon.imaging.NoNotificationImages
import io.rebble.libpebblecommon.imaging.NotificationImageProvider
import io.rebble.libpebblecommon.music.SystemMusicControl
import io.rebble.libpebblecommon.notification.NotificationAppsSync
import io.rebble.libpebblecommon.notification.NotificationListenerConnection
import io.rebble.libpebblecommon.packets.PhoneAppVersion
import io.rebble.libpebblecommon.plugin.PhoneBatteryMonitor
import io.rebble.libpebblecommon.plugin.PhoneNetworkMonitor
import io.rebble.libpebblecommon.plugin.PlatformPlugins
import io.rebble.libpebblecommon.util.SystemGeolocation
import org.koin.core.module.Module
import org.koin.core.module.dsl.singleOf
import org.koin.dsl.bind
import org.koin.dsl.module

/**
 * The browser phone's platform bindings, in the shape of upstream's Android and iOS
 * modules. It identifies as Android, the notification pipeline it models, and declares
 * only the shared capabilities: the Android-only ones (extended music, image fetch,
 * two-way dismissal) need services the browser does not have yet.
 */
actual val platformModule: Module = module {
    single { PhoneCapabilities(CommonPhoneCapabilities) }
    single { PlatformFlags(PhoneAppVersion.PlatformFlag.makeFlags(PhoneAppVersion.OSType.Android, emptyList())) }
    singleOf(::BrowserNotificationListenerConnection) bind NotificationListenerConnection::class
    singleOf(::BrowserNotificationActionHandler) bind PlatformNotificationActionHandler::class
    singleOf(::BrowserNotificationAppsSync) bind NotificationAppsSync::class
    singleOf(::BrowserSystemCalendar) bind SystemCalendar::class
    singleOf(::BrowserCalendarActionHandler) bind PlatformCalendarActionHandler::class
    singleOf(::BrowserSystemCallLog) bind SystemCallLog::class
    singleOf(::BrowserSystemMusicControl) bind SystemMusicControl::class
    singleOf(::NoNotificationImages) bind NotificationImageProvider::class
    singleOf(::BrowserSystemGeolocation) bind SystemGeolocation::class
    singleOf(::BrowserOtherPebbleApps) bind OtherPebbleApps::class
    singleOf(::BrowserSystemContacts) bind SystemContacts::class
    singleOf(::BrowserLegacyPhoneReceiver) bind LegacyPhoneReceiver::class
    singleOf(::PhoneBatteryMonitor)
    singleOf(::PhoneNetworkMonitor)
    single { PlatformPlugins(emptySet()) }
    single { PlatformConfig(syncNotificationApps = false) }
    single { BlePlatformConfig() }
    singleOf(::JvmClassicScanner) bind ClassicScanner::class
}
