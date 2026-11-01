# Disposable installer-only systemd box. Runtime work is a labelled fixture.
FROM ubuntu:24.04@sha256:fe81560990fae86dc4743202b2cb4d3df98d0bcf949173cecef15ce1127ef852
ENV container=docker DEBIAN_FRONTEND=noninteractive VOLLI_INSTALLER_CI_BOX=1
RUN apt-get update \
    && apt-get install -y --no-install-recommends systemd systemd-sysv dbus dbus-user-session sudo procps ca-certificates git libstdc++6 \
    && rm -rf /var/lib/apt/lists/*
RUN systemctl mask systemd-udevd.service systemd-udev-trigger.service \
      systemd-udevd-control.socket systemd-udevd-kernel.socket \
      systemd-networkd.service systemd-networkd.socket systemd-resolved.service \
      systemd-timesyncd.service getty.target console-getty.service \
      systemd-firstboot.service systemd-modules-load.service \
      sys-kernel-config.mount sys-kernel-debug.mount sys-kernel-tracing.mount \
    && rm -f /etc/machine-id && touch /etc/machine-id
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
