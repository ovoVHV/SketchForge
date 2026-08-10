# FCMP/1 Serial Transport

FCMP/1 is the bounded binary transport used between the browser and a Forge
Runtime. It moves a manifest and content-addressed artifact; it does not flash
the board firmware.

## Frame

All multi-byte integers are unsigned little-endian values.

| Offset | Bytes | Field |
|---:|---:|---|
| 0 | 4 | ASCII magic `FCMP` |
| 4 | 1 | protocol version, `1` |
| 5 | 1 | frame type |
| 6 | 2 | flags, reserved as zero in v1 |
| 8 | 4 | sequence number |
| 12 | 4 | payload byte length |
| 16 | 4 | CRC-32/ISO-HDLC of bytes 0–15 followed by payload |
| 20 | N | payload, at most 4096 bytes |

A decoder must reject invalid magic, unsupported versions, non-zero reserved
flags, payloads over 4096 bytes, sequence gaps, and CRC mismatches before
processing the payload.

## Frame Types

| Value | Name | Direction | Payload |
|---:|---|---|---|
| 1 | `HELLO` | host -> device | UTF-8 JSON client capabilities |
| 2 | `HELLO_ACK` | device -> host | UTF-8 JSON runtime and ABI versions |
| 3 | `BEGIN` | host -> device | UTF-8 JSON manifest |
| 4 | `CHUNK` | host -> device | Raw Wasm bytes |
| 5 | `COMMIT` | host -> device | 32 raw SHA-256 bytes |
| 6 | `ACTIVATE` | host -> device | Empty |
| 7 | `ROLLBACK` | host -> device | Empty |
| 8 | `STATUS` | either | UTF-8 JSON state or error |
| 9 | `ACK` | device -> host | Four-byte acknowledged sequence |

## Deployment State Machine

```text
idle
  -> BEGIN(manifest)
  -> staging
  -> CHUNK * N
  -> COMMIT(digest)
  -> verified
  -> ACTIVATE
  -> active
```

`BEGIN` validates bounded manifest fields before allocating artifact storage.
`COMMIT` succeeds only when the received byte count and SHA-256 match the
manifest. `ACTIVATE` calls `init`; failure leaves the previous active component
unchanged. `ROLLBACK` atomically selects `previous-good` when one exists.

The first implementation uses stop-and-wait ACKs. This is slower than a windowed
protocol but keeps RAM and retry behavior deterministic for the architecture
spike.

