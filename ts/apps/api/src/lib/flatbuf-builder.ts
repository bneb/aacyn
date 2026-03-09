/**
 * FlatBuffer Builder — Hand-Rolled, Zero Dependencies
 *
 * Constructs the exact binary wire format that libaacyn.c expects.
 * Shared between tests and the benchmark payload generator.
 *
 * Wire Layout:
 *   [root_offset:4] [vtable:8] [table_data:12] [trace_id_string] [events_vector]
 *
 * EventStruct (FlatBuffers struct, inline, 16 bytes):
 *   [timestamp:u64] [duration_ms:f32] [status_code:u16] [pad:u16]
 */

export interface FlatBufferEvent {
    timestamp: bigint;
    durationMs: number;
    statusCode: number;
}

interface FlatBufferLayout {
    traceIdBytes: Uint8Array;
    traceIdPadding: number;
    vtableSize: number;
    tableDataSize: number;
    traceIdStringSize: number;
    eventsVectorSize: number;
    totalSize: number;
}

function computeFlatBufferLayout(traceId: string, eventCount: number): FlatBufferLayout {
    const traceIdBytes = new TextEncoder().encode(traceId);
    const traceIdPadding = (4 - ((traceIdBytes.length + 1) % 4)) % 4;
    const vtableSize = 8;
    const tableDataSize = 12;
    const traceIdStringSize = 4 + traceIdBytes.length + 1 + traceIdPadding;
    const eventsVectorSize = 4 + (eventCount * 16);

    return {
        traceIdBytes,
        traceIdPadding,
        vtableSize,
        tableDataSize,
        traceIdStringSize,
        eventsVectorSize,
        totalSize: 4 + vtableSize + tableDataSize + traceIdStringSize + eventsVectorSize,
    };
}

function writeHeaderAndTableFields(
    view: DataView,
    offset: number,
    vtableSize: number,
    tableDataSize: number,
    traceIdStringSize: number,
    eventsVectorSize: number,
): number {
    const tableStart = 4 + vtableSize;
    view.setUint32(offset, tableStart, true);
    offset += 4;

    const vtableStart = offset;
    view.setUint16(offset, vtableSize, true);
    view.setUint16(offset + 2, tableDataSize, true);
    view.setUint16(offset + 4, 4, true);  // trace_id field offset
    view.setUint16(offset + 6, 8, true);  // events field offset
    offset += vtableSize;

    const tableDataStart = offset;
    view.setInt32(offset, tableDataStart - vtableStart, true);
    offset += 4;

    const traceIdFieldPos = offset;
    const traceIdDataPos = tableDataStart + tableDataSize;
    view.setUint32(offset, traceIdDataPos - traceIdFieldPos, true);
    offset += 4;

    const eventsFieldPos = offset;
    const eventsDataPos = traceIdDataPos + traceIdStringSize;
    view.setUint32(offset, eventsDataPos - eventsFieldPos, true);
    offset += 4;

    return offset;
}

function writeTraceIdString(
    view: DataView,
    bytes: Uint8Array,
    offset: number,
    traceIdBytes: Uint8Array,
    traceIdPadding: number,
): number {
    view.setUint32(offset, traceIdBytes.length, true);
    offset += 4;
    bytes.set(traceIdBytes, offset);
    offset += traceIdBytes.length;
    bytes[offset] = 0;
    offset += 1 + traceIdPadding;
    return offset;
}

function writeEventsVector(
    view: DataView,
    bytes: Uint8Array,
    offset: number,
    events: FlatBufferEvent[],
): number {
    const eventStructSize = 16;
    view.setUint32(offset, events.length, true);
    offset += 4;

    for (const event of events) {
        view.setBigUint64(offset, event.timestamp, true);
        view.setFloat32(offset + 8, event.durationMs, true);
        view.setUint16(offset + 12, event.statusCode, true);
        view.setUint16(offset + 14, 0, true);
        offset += eventStructSize;
    }
    return offset;
}

export function buildFlatBufferPayload(
    traceId: string,
    events: FlatBufferEvent[],
): ArrayBuffer {
    const layout = computeFlatBufferLayout(traceId, events.length);

    const buf = new ArrayBuffer(layout.totalSize);
    const view = new DataView(buf);
    const bytes = new Uint8Array(buf);

    let offset = writeHeaderAndTableFields(
        view, 0,
        layout.vtableSize, layout.tableDataSize,
        layout.traceIdStringSize, layout.eventsVectorSize,
    );
    offset = writeTraceIdString(view, bytes, offset, layout.traceIdBytes, layout.traceIdPadding);
    offset = writeEventsVector(view, bytes, offset, events);

    return buf;
}
