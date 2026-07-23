export function createArcSmokeSchedule(latestTimestamp) {
  return Object.freeze({
    commitOpensAt: latestTimestamp + 60,
    revealOpensAt: latestTimestamp + 90,
    revealClosesAt: latestTimestamp + 120,
  });
}
