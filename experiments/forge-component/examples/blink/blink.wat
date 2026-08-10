(module
  (import "forge:embedded/gpio@0.1" "configure"
    (func $gpio-configure (param i32 i32 i32) (result i32)))
  (import "forge:embedded/gpio@0.1" "write"
    (func $gpio-write (param i32 i32 i32) (result i32)))
  (import "forge:embedded/timer@0.1" "sleep-ms"
    (func $timer-sleep-ms (param i32) (result i32)))

  (memory (export "memory") 1 1)

  (global $gpio-capability i32 (i32.const 1))
  (global $led-pin i32 (i32.const 8))
  (global $period-ms (mut i32) (i32.const 250))
  (global $level (mut i32) (i32.const 0))

  (func (export "init") (result i32)
    global.get $gpio-capability
    global.get $led-pin
    i32.const 1
    call $gpio-configure)

  (func (export "tick") (result i32)
    (local $status i32)

    global.get $level
    i32.eqz
    global.set $level

    global.get $gpio-capability
    global.get $led-pin
    global.get $level
    call $gpio-write
    local.tee $status
    if
      local.get $status
      return
    end

    global.get $period-ms
    call $timer-sleep-ms)

  (func (export "set-period-ms") (param $value i32) (result i32)
    local.get $value
    i32.const 25
    i32.lt_u
    if
      i32.const 3
      return
    end

    local.get $value
    i32.const 2000
    i32.gt_u
    if
      i32.const 3
      return
    end

    local.get $value
    global.set $period-ms
    i32.const 0))

