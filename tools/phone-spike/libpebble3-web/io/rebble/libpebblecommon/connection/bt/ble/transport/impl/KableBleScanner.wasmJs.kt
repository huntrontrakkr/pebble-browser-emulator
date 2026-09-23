package io.rebble.libpebblecommon.connection.bt.ble.transport.impl

import com.juul.kable.Advertisement
import com.juul.kable.Identifier
import io.rebble.libpebblecommon.BleConfig
import io.rebble.libpebblecommon.BleConfigFlow
import io.rebble.libpebblecommon.connection.BleScanResult
import io.rebble.libpebblecommon.connection.PebbleBleIdentifier
import io.rebble.libpebblecommon.connection.bt.ble.transport.BleScanner
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow

// The browser phone reaches the emulated watch over its serial link, not Bluetooth, so a
// BLE scan finds nothing. The simulated Bluetooth link replaces this (docs/ROADMAP.md).
actual fun kableBleScanner(bleConfigFlow: BleConfigFlow): BleScanner = object : BleScanner {
    override fun scan(): Flow<BleScanResult> = emptyFlow()
}

internal actual fun createKableAdvertisementsFlow(bleConfig: BleConfig): Flow<Advertisement> = emptyFlow()

actual fun Identifier.asPebbleBleIdentifier(): PebbleBleIdentifier =
    error("The browser phone has no Bluetooth identifiers")

actual fun configureKableCentral(stateRestoration: Boolean) = Unit
