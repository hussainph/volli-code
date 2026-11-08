# The BYO lane's "fresh box" (VC-1043): stock Ubuntu 24.04 booted with systemd
# as PID 1, the way a rented VPS comes up. It holds only what such a box ships
# with and what install.sh expects to find (curl, CA roots, tar/gzip, git for
# the Sessions): no Node, no Volli, no repo. install.sh never installs
# packages, so nothing here may stand in for one it should have downloaded.
#
# Multi-arch index digest for ubuntu:24.04. Update the tag AND the digest.
FROM ubuntu:24.04@sha256:fe81560990fae86dc4743202b2cb4d3df98d0bcf949173cecef15ce1127ef852

ENV container=docker DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        systemd systemd-sysv dbus ca-certificates curl git \
    && rm -rf /var/lib/apt/lists/*

# A container shares the runner's kernel and, here, its network: units that
# would manage hardware, the network or the clock are the host's business.
RUN systemctl mask \
        systemd-udevd.service systemd-udev-trigger.service systemd-udevd-control.socket \
        systemd-udevd-kernel.socket systemd-networkd.service systemd-networkd.socket \
        systemd-resolved.service systemd-timesyncd.service getty.target \
        console-getty.service systemd-firstboot.service systemd-modules-load.service \
        sys-kernel-config.mount sys-kernel-debug.mount sys-kernel-tracing.mount \
    && rm -f /etc/machine-id && touch /etc/machine-id

STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
