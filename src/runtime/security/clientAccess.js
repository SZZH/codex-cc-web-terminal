export function installClientAccessRuntime(runtime) {
  runtime.getClientAddress = (req) => String(req.socket.remoteAddress || "");

  runtime.normalizeIp = (address) => {
    const value = String(address || "").trim();
    if (!value) {
      return "";
    }
    if (value === "::1") {
      return "127.0.0.1";
    }
    if (value.startsWith("::ffff:")) {
      return value.slice(7);
    }
    return value;
  };

  runtime.ipv4ToInt = (address) => {
    const parts = runtime
      .normalizeIp(address)
      .split(".")
      .map((part) => Number.parseInt(part, 10));
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
      return null;
    }
    return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
  };

  runtime.isTailscaleIpv6 = (address) => runtime.normalizeIp(address).toLowerCase().startsWith("fd7a:115c:a1e0:");

  runtime.cidrContains = (cidr, address) => {
    const [baseAddress, prefixText] = String(cidr || "").split("/");
    const prefix = Number.parseInt(prefixText, 10);
    const baseInt = runtime.ipv4ToInt(baseAddress);
    const targetInt = runtime.ipv4ToInt(address);
    if (baseInt === null || targetInt === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
      return false;
    }
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (baseInt & mask) === (targetInt & mask);
  };

  runtime.getAllowedCidrs = () => {
    const cidrs = [...runtime.config.trustedCidrs];
    if (runtime.config.tailscaleOnly) {
      cidrs.push("100.64.0.0/10", "127.0.0.0/8");
    }
    return cidrs;
  };

  runtime.isAllowedClient = (req) => {
    const cidrs = runtime.getAllowedCidrs();
    if (cidrs.length === 0) {
      return true;
    }
    const clientIp = runtime.getClientAddress(req);
    if (runtime.config.tailscaleOnly && runtime.isTailscaleIpv6(clientIp)) {
      return true;
    }
    return cidrs.some((cidr) => runtime.cidrContains(cidr, clientIp));
  };
}
