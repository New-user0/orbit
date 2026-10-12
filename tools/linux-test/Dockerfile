# The image tools/linux-test/linux-test.sh runs packages in: what CI's ubuntu test job has, as a user who is not root.
FROM oven/bun:1.4.2
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ripgrep bubblewrap socat ca-certificates procps curl xz-utils fd-find zsh \
 && ln -s "$(command -v fdfind)" /usr/local/bin/fd \
 && rm -rf /var/lib/apt/lists/*
# Some tests start Node (the VS Code extension runs under it); the TUI's ESM reload tests need module.registerHooks,
# which Node has from 22.15.
RUN curl -fsSL https://nodejs.org/dist/v22.15.0/node-v22.15.0-linux-x64.tar.xz | tar -xJ -C /opt \
 && ln -s /opt/node-v22.15.0-linux-x64/bin/node /usr/local/bin/node
# The shell-analysis tests run their zsh rows, their fd marker control and their PowerShell host rows only when the
# program is on PATH (fd-find installs `fdfind`, hence the link above). PowerShell 7 comes from its release tarball;
# invariant globalization spares the image libicu.
ENV DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1 POWERSHELL_TELEMETRY_OPTOUT=1 POWERSHELL_UPDATECHECK=Off
RUN mkdir -p /opt/microsoft/powershell/7 \
 && curl -fsSL https://github.com/PowerShell/PowerShell/releases/download/v7.4.6/powershell-7.4.6-linux-x64.tar.gz | tar -xz -C /opt/microsoft/powershell/7 \
 && chmod +x /opt/microsoft/powershell/7/pwsh \
 && ln -s /opt/microsoft/powershell/7/pwsh /usr/local/bin/pwsh
# CI runs as a non-root user; root ignores file permission bits, so permission tests would pass without testing anything.
RUN useradd --create-home --shell /bin/bash tester
USER tester
WORKDIR /home/tester
