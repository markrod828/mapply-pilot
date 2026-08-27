import { EMPTY_ADDRESS, EMPTY_PROFILE, type Address, type Profile } from './types';

/** "Vernon, CA, USA" — the one-line form a resume header and a "location" field want. */
export function formatLocation(address: Address): string {
  return [address.city, address.state, address.country].filter(Boolean).join(', ');
}

/** The full postal address on one line, for forms with a single address box. */
export function formatAddress(address: Address): string {
  // The postal code rides with the region — "San Francisco, CA 94102" — the way it is
  // written on an envelope, rather than trailing after the country.
  const region = [address.state, address.postalCode].filter(Boolean).join(' ');
  return [address.line1, address.line2, address.city, region, address.country]
    .filter(Boolean)
    .join(', ');
}

/** The flat location fields a profile carried before the address became its own object. */
interface LegacyProfile {
  city?: unknown;
  state?: unknown;
  country?: unknown;
}

const asText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/**
 * Fills in whatever a stored profile is missing and lifts the pre-nesting location
 * fields into `address`.
 *
 * Worth doing rather than letting the defaults win: a profile is hand-typed, so
 * silently dropping someone's saved city because the shape moved would make them
 * enter it again with no hint as to why.
 */
export function migrateProfile(stored: Partial<Profile>): Profile {
  const legacy = stored as LegacyProfile;
  const address = { ...EMPTY_ADDRESS, ...(stored.address ?? {}) };

  return {
    ...EMPTY_PROFILE,
    ...stored,
    address: {
      ...address,
      city: address.city || asText(legacy.city),
      state: address.state || asText(legacy.state),
      country: address.country || asText(legacy.country),
    },
  };
}
