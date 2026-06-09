import { logger } from "./Logger";
import type { ShellyConfig } from "./ShellyService";

export interface ShellyAuthObject {
  algorithm: "SHA-256";
  auth_type: "digest";
  cnonce: string;
  nc: number;
  nonce: number;
  realm: string;
  response: string;
  username: string;
}

interface AuthChallenge {
  nonce: number;
  nonceRaw: string;
  realm: string;
  algorithm: string;
  stale?: boolean;
  isLegacy?: boolean;
}

class ShellyAuthService {
  private config: ShellyConfig;
  private authObject: ShellyAuthObject | null = null;
  private ha1: string | null = null;

  constructor(config: ShellyConfig) {
    this.config = config;
  }

  /**
   * Returns a ready-to-use auth object for RPC requests.
   * Handles initial login and nonce refresh automatically.
   */
  public async getAuthObject(): Promise<ShellyAuthObject> {
    // If we have a valid auth object, increment nc and return
    if (this.authObject) {
      this.incrementNonceCount();
      return this.authObject;
    }

    // Perform initial authentication
    await this.authenticate();

    if (!this.authObject) {
      throw new Error("Authentication failed");
    }

    return this.authObject;
  }

  /**
   * Resets the session, forcing a new login on next call.
   */
  public reset() {
    this.authObject = null;
    this.ha1 = null;
  }

  private generateCNonce(): string {
    const randomBytes = new Uint8Array(16);
    crypto.getRandomValues(randomBytes);

    // Convert to Base64
    // Note: In Node.js use Buffer.from(randomBytes).toString('base64')
    // In Browser use btoa(String.fromCharCode(...randomBytes))
    return btoa(String.fromCharCode(...randomBytes));
  }

  private async authenticate(): Promise<void> {
    if (!this.config.username || !this.config.password) {
      return;
    }

    const realm = await this.discoverRealm();

    // 2. Calculate HA1 (can be cached)
    this.ha1 = await this.calculateHA1(this.config.username, realm, this.config.password);
    // console.log(`ha1: ` + this.ha1);
    // 3. Initial request to get nonce (Challenge)
    const challenge = await this.getChallenge();

    // 4. Build Auth Object
    const cnonce = this.generateCNonce();

    const responseHash = await this.calculateResponseLegacy(
      this.ha1,
      challenge.nonce,
      cnonce,
    );

    this.authObject = {
      realm: challenge.realm,
      username: "admin",
      // Legacy expects a number, Modern expects a Base64 string
      nonce: parseInt(challenge.nonceRaw),
      cnonce: cnonce,
      nc: 1,
      response: responseHash,
      algorithm: "SHA-256",
      auth_type: "digest",
    };

  }

  private async discoverRealm(): Promise<string> {
    try {
      const res = await fetch(`http://${this.config.host}/shelly`);
      if (!res.ok) throw new Error("Failed to fetch device info");
      const data = await res.json();
      return data.id;
    } catch (e) {
      throw new Error(`Could not discover realm: ${e}`);
    }
  }

  // Use a protected method like 'Shelly.GetStatus' to trigger 401  
  // 'Shelly.GetDeviceInfo' returns 200 OK even when auth is enabled
  public async testAuthWorks(): Promise<undefined> {
    const url = `http://${this.config.host}/rpc`;
    // console.log(this.authObject)

    const response = await fetch(url, {
      method: 'POST',
      verbose: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 1,
        method: "Shelly.GetStatus",
        auth: this.authObject
      })
    });

    if (response.status !== 200) {
      throw new Error(`Expected 200, got ${response.status}`);
    }
    logger.info('Testing if authentication works')
  }


  private async getChallenge(): Promise<AuthChallenge> {
    const url = `http://${this.config.host}/rpc`;

    // CHANGE: Use a protected method like 'Shelly.GetStatus' to trigger 401
    // 'Shelly.GetDeviceInfo' returns 200 OK even when auth is enabled
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 0, method: "Shelly.GetStatus" })
    });

    if (response.status !== 401) {
      // If not 401, auth might be disabled or already handled externally
      throw new Error(`Expected 401 Unauthorized, got ${response.status}`);
    }

    const authHeader = response.headers.get('WWW-Authenticate');
    if (!authHeader) {
      // Fallback: try parsing JSON error body if header is missing (WebSocket style)
      const errorBody = await response.json().catch(() => null);
      if (errorBody?.error?.message) {
        const msg = JSON.parse(errorBody.error.message);
        return {
          nonce: msg.nonce,
          nonceRaw: msg.nonce,
          realm: msg.realm,
          algorithm: msg.algorithm,
          stale: msg.stale
        };
      }
      throw new Error("No WWW-Authenticate header found");
    }

    // Parse Digest parameters from header
    // Format: Digest qop="auth", realm="...", nonce="...", algorithm=SHA-256
    const nonceMatch = authHeader.match(/nonce="([^"]+)"/);
    const realmMatch = authHeader.match(/realm="([^"]+)"/);
    const staleMatch = authHeader.match(/stale=([a-zA-Z]+)/);

    const nonceRaw = nonceMatch ? nonceMatch[1] : null;

    if (!nonceRaw) throw new Error("No nonce found");

    // Detect format: Legacy uses numbers, Modern uses Base64 (contains non-numeric chars)
    const isLegacy = /^\d+$/.test(nonceRaw);

    if (!nonceMatch || !realmMatch) {
      throw new Error("Failed to parse auth challenge");
    }

    return {
      nonce: isLegacy ? parseInt(nonceRaw, 10) as any : nonceRaw, // Store as number for legacy, string for modern
      nonceRaw: nonceRaw, // Keep raw string for hash calculation if needed
      realm: realmMatch[1],
      isLegacy: isLegacy,
      algorithm: "SHA-256",
      stale: staleMatch ? staleMatch[1].toLowerCase() === 'true' : false
    };
  }

  private async calculateHA1(username: string, realm: string, password: string): Promise<string> {
    const data = `${username}:${realm}:${password}`;
    // console.log(data)

    const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
    return Array.from(new Uint8Array(hashBuffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  private async calculateResponseLegacy(
    ha1: string,
    nonce: number, // Must be number for legacy
    cnonce: string
  ): Promise<string> {
    // CRITICAL: Legacy RPC uses this EXACT static string for HA2
    const ha2Data = "dummy_method:dummy_uri";

    const ha2Buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ha2Data));
    const ha2 = Array.from(new Uint8Array(ha2Buffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    // Legacy typically uses nc = "1" always
    const nc = "1";

    // Response = SHA256(HA1:nonce:nc:cnonce:auth:HA2)
    // Note: nonce is converted to string here for the hash input
    const responseData = `${ha1}:${nonce}:${nc}:${cnonce}:auth:${ha2}`;

    const responseBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(responseData));

    return Array.from(new Uint8Array(responseBuffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  private incrementNonceCount() {
    if (!this.authObject) return;

    this.authObject.nc = this.authObject.nc++;

    // Recalculate response hash with new nc
    if (this.ha1) {
      this.calculateResponseLegacy(
        this.ha1,
        this.authObject.nonce,
        this.authObject.cnonce
      ).then(newResponse => {
        this.authObject!.response = newResponse;
      });
    }
  }

  /**
   * Call this if you receive a 401 stale=true error during a request
   */
  public async handleStaleNonce() {
    this.authObject = null; // Force re-auth
    await this.authenticate();
  }
}

export default ShellyAuthService;   