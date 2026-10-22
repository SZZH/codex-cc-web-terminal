// A directory can belong to multiple saved projects; keep their identities intact.
export function buildProjectChoices(groups) {
  const buckets = new Map();
  for (const group of groups) {
    const key = JSON.stringify([group.name, group.cwd]);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(group);
  }
  return groups.map((group) => {
    const peers = buckets.get(JSON.stringify([group.name, group.cwd]));
    if (peers.length < 2) return { group, detail: "" };
    const describe = (item) => {
      const count = item.catalogPage?.total;
      const parts = Number.isInteger(count) ? [`${count} 个会话`] : [];
      const date = item.createdAt ? new Date(item.createdAt) : null;
      if (date && !Number.isNaN(date.getTime())) parts.push(`${date.toISOString().slice(0, 10)} 创建`);
      return parts.join(" · ");
    };
    let detail = describe(group);
    if (peers.filter((peer) => describe(peer) === detail).length > 1) {
      const identity = String(group.projectId || group.id || "");
      let length = 8;
      while (length < identity.length && peers.some((peer) => peer !== group
        && String(peer.projectId || peer.id || "").slice(-length) === identity.slice(-length))) length++;
      detail = [detail, `项目 ${identity.slice(-length)}`].filter(Boolean).join(" · ");
    }
    return { group, detail };
  });
}
