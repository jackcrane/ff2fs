# FF2FS

Local ForeFlight-to-MSFS 2024 route bridge. ForeFlight sees a compatible SkyView panel over Wi-Fi, delivers the plan to this receiver, and the MSFS 2024 EFB route manager synchronizes it with the EFB, ATC, and compatible avionics.

## Start

Double-click `start-receiver.cmd`. It opens a visible Command Prompt, installs the narrowly scoped local-subnet firewall rules when required, and starts the receiver.

The `ff2fs-efb-bridge` package must be installed in the MSFS 2024 Community folder and MSFS must be restarted after adding or updating it.

## Safety

This is simulator-only software, not certified avionics software. Never connect it to or rely on it in an aircraft.
