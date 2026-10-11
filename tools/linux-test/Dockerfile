# The image tools/linux-test/linux-test.sh runs packages in: what CI's ubuntu test job has, as a user who is not root.
FROM oven/bun:1.4.2
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ripgrep bubblewrap socat ca-certificates procps curl xz-utils \
 && rm -rf /var/lib/apt/lists/*
# Some tests start Node (the VS Code extension runs under it); the TUI's ESM reload tests need module.registerHooks,
# which Node has from 22.15.
RUN curl -fsSL https://nodejs.org/dist/v22.15.0/node-v22.15.0-linux-x64.tar.xz | tar -xJ -C /opt \
 && ln -s /opt/node-v22.15.0-linux-x64/bin/node /usr/local/bin/node
# CI runs as a non-root user; root ignores file permission bits, so permission tests would pass without testing anything.
RUN useradd --create-home --shell /bin/bash tester
USER tester
WORKDIR /home/tester
