# game-client

Headless CoD2 UDP peer: connectionless handshake, sequenced packets, and a snapshot parser. Spectator only.

## Building

Run `nx build game-client` to build the library.

## Running unit tests

Run `nx test game-client` to execute the unit tests via [Vitest](https://vitest.dev/).

Tests use committed fixtures. They do not open the game port.
