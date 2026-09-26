import axios, { AxiosInstance } from 'axios';
import { config } from './config.js';
import { getStoredSession, clearSession, SessionData } from './auth.js';

export class WcapiClient {
  private http: AxiosInstance;
  private session: SessionData | null = null;

  constructor() {
    this.http = axios.create({
      baseURL: config.wcapiBaseUrl,
      headers: {
        'Content-Type': 'text/plain',
      },
      timeout: 15000,
    });
  }

  /**
   * Ensures active session is loaded
   */
  private getAuthSession(): SessionData {
    this.session = getStoredSession();
    if (!this.session || !this.session.susertoken) {
      throw new Error(
        'Not authenticated with Kambala WCAPI. Session is inactive or logged out at broker end.'
      );
    }
    return this.session;
  }

  /**
   * Proactively checks if the stored session is genuinely active with Kambala WCAPI.
   * If logged out at the admin end or expired, it automatically wipes the dead session.
   */
  async validateSessionLive(): Promise<{ isValid: boolean; user?: string; error?: string }> {
    const stored = getStoredSession();
    if (!stored || !stored.susertoken) {
      return { isValid: false, error: 'No session token configured' };
    }
    try {
      const data = await this.getUserDetails();
      if (data && data.stat === 'Ok') {
        return { isValid: true, user: data.uname || data.uid };
      }
      clearSession();
      return { isValid: false, error: data?.emsg || 'Session rejected by broker' };
    } catch (err: any) {
      clearSession();
      return { isValid: false, error: err.message };
    }
  }

  /**
   * Executes a WCAPI POST request with the mandatory jData payload format and Authorization header.
   */
  private async postWcapi<T = any>(endpoint: string, jData: Record<string, any>): Promise<T> {
    const session = this.getAuthSession();
    const payload = `jData=${JSON.stringify(jData)}`;
    const targetEndpoint = endpoint.startsWith(config.apiPrefix)
      ? endpoint
      : `${config.apiPrefix}${endpoint.replace(/^\/NorenWClient(API|Web)/, '')}`;

    try {
      const response = await this.http.post<T>(targetEndpoint, payload, {
        headers: {
          Authorization: `Bearer ${session.susertoken}`,
        },
      });

      const data: any = response.data;
      if (data && data.stat === 'Not_Ok') {
        const emsg = data.emsg || 'Unknown error';
        if (emsg.includes('Session Expired') || emsg.includes('Invalid Session Key')) {
          console.warn(`[WCAPI] Session expired or logged out at admin end: ${emsg}. Clearing dead session.`);
          clearSession();
        }
        throw new Error(`WCAPI Error [${targetEndpoint}]: ${emsg}`);
      }

      return data;
    } catch (err: any) {
      if (err.response?.status === 401 || err.message?.includes('401')) {
        console.warn(`[WCAPI] 401 Unauthorized received. Clearing dead session.`);
        clearSession();
      }
      throw err;
    }
  }

  /**
   * Fetches user profile / details
   */
  async getUserDetails(uid?: string) {
    const session = this.getAuthSession();
    const userId = uid || session.uid || config.clientId;
    return this.postWcapi('/NorenWClientAPI/UserDetails', { uid: userId });
  }

  /**
   * Fetches account limits, balance, and margin available
   */
  async getLimits(uid?: string, actid?: string, seg?: string) {
    const session = this.getAuthSession();
    const userId = uid || session.uid || config.clientId;
    const accountId = actid || session.actid || userId;
    const payload: Record<string, any> = { uid: userId, actid: accountId };
    if (seg) payload.seg = seg;
    return this.postWcapi('/NorenWClientAPI/Limits', payload);
  }

  /**
   * Fetches detailed sub-limits breakdown
   */
  async getSubLimits(uid?: string, actid?: string) {
    const session = this.getAuthSession();
    const userId = uid || session.uid || config.clientId;
    const accountId = actid || session.actid || userId;
    return this.postWcapi('/NorenWClientAPI/GetSubLimits', { uid: userId, actid: accountId });
  }

  /**
   * Fetches Demat / Long-term Holdings
   */
  async getHoldings(uid?: string, actid?: string, prd = 'C') {
    const session = this.getAuthSession();
    const userId = uid || session.uid || 'KKSINV';
    const accountId = actid || session.actid || userId;
    return this.postWcapi('/Holdings', { uid: userId, actid: accountId, prd });
  }

  /**
   * Fetches Intraday & F&O Positions Book
   */
  async getPositions(uid?: string, actid?: string) {
    const session = this.getAuthSession();
    const userId = uid || session.uid || 'KKSINV';
    const accountId = actid || session.actid || userId;
    return this.postWcapi('/PositionBook', { uid: userId, actid: accountId });
  }

  /**
   * Fetches Order Book (All orders placed today)
   */
  async getOrderBook(uid?: string) {
    const session = this.getAuthSession();
    const userId = uid || session.uid || 'KKSINV';
    return this.postWcapi('/OrderBook', { uid: userId });
  }

  /**
   * Fetches Trade Book (All executed trades)
   */
  async getTradeBook(uid?: string, actid?: string) {
    const session = this.getAuthSession();
    const userId = uid || session.uid || 'KKSINV';
    const accountId = actid || session.actid || userId;
    return this.postWcapi('/TradeBook', { uid: userId, actid: accountId });
  }

  /**
   * Searches scrips/instruments by symbol or name
   * @param exch Exchange (NSE, NFO, BSE, MCX, etc.)
   * @param stext Search text (e.g. "RELIANCE", "NIFTY")
   */
  async searchScrips(exch: string, stext: string) {
    const session = this.getAuthSession();
    const userId = session.uid || 'KKSINV';
    return this.postWcapi('/SearchScrip', { uid: userId, exch, stext });
  }

  /**
   * Fetches live market quote & 5-depth for an instrument
   * @param exch Exchange (NSE, NFO, BSE, MCX)
   * @param token Scrip token (e.g. "2885" for Reliance)
   */
  async getQuotes(exch: string, token: string) {
    const session = this.getAuthSession();
    const userId = session.uid || 'KKSINV';
    return this.postWcapi('/GetQuotes', { uid: userId, exch, token });
  }

  /**
   * Fetches detailed security / contract info
   */
  async getSecurityInfo(exch: string, token: string) {
    const session = this.getAuthSession();
    const userId = session.uid || config.clientId;
    return this.postWcapi('/NorenWClientAPI/GetSecurityInfo', { uid: userId, exch, token });
  }

  /**
   * Simulates order margin requirements before placing an order
   */
  async checkOrderMargin(params: {
    exch: string;
    tsym: string;
    qty: string | number;
    prc: string | number;
    prd: 'C' | 'M' | 'I' | 'F' | 'S' | 'P';
    trantype: 'B' | 'S';
    prctyp: 'LMT' | 'MKT' | 'SL-LMT' | 'SL-MKT';
  }) {
    const session = this.getAuthSession();
    const userId = session.uid || config.clientId;
    const accountId = session.actid || userId;

    return this.postWcapi('/NorenWClientAPI/OrderMargin', {
      uid: userId,
      actid: accountId,
      exch: params.exch,
      tsym: params.tsym,
      qty: String(params.qty),
      prc: String(params.prc),
      prd: params.prd,
      trantype: params.trantype,
      prctyp: params.prctyp,
    });
  }

  /**
   * Places an order directly into OMS/RMS
   */
  async placeOrder(params: {
    exch: string;
    tsym: string;
    qty: string | number;
    prc: string | number;
    prd: 'C' | 'M' | 'I' | 'F' | 'S' | 'P';
    trantype: 'B' | 'S';
    prctyp: 'LMT' | 'MKT' | 'SL-LMT';
    ret?: 'DAY' | 'EOS' | 'IOC';
    trgprc?: string | number;
    remarks?: string;
  }) {
    const session = this.getAuthSession();
    const userId = session.uid || config.clientId;
    const accountId = session.actid || userId;

    return this.postWcapi('/NorenWClientAPI/PlaceOrder', {
      uid: userId,
      actid: accountId,
      exch: params.exch,
      tsym: params.tsym,
      qty: String(params.qty),
      prc: String(params.prc),
      prd: params.prd,
      trantype: params.trantype,
      prctyp: params.prctyp,
      ret: params.ret || 'DAY',
      trgprc: params.trgprc ? String(params.trgprc) : undefined,
      remarks: params.remarks || 'AI_MCP_ORDER',
      ordersource: 'WEB',
    });
  }

  /**
   * Modifies an existing open order
   */
  async modifyOrder(params: {
    norenordno: string;
    exch: string;
    tsym: string;
    qty: string | number;
    prc: string | number;
    prctyp: 'LMT' | 'SL-LMT';
    trgprc?: string | number;
  }) {
    const session = this.getAuthSession();
    const userId = session.uid || config.clientId;

    return this.postWcapi('/NorenWClientAPI/ModifyOrder', {
      uid: userId,
      norenordno: params.norenordno,
      exch: params.exch,
      tsym: params.tsym,
      qty: String(params.qty),
      prc: String(params.prc),
      prctyp: params.prctyp,
      trgprc: params.trgprc ? String(params.trgprc) : undefined,
    });
  }

  /**
   * Cancels an open order
   */
  async cancelOrder(norenordno: string) {
    const session = this.getAuthSession();
    const userId = session.uid || config.clientId;

    return this.postWcapi('/NorenWClientAPI/CancelOrder', {
      uid: userId,
      norenordno,
    });
  }
}
