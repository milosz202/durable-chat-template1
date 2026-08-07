import { createRoot } from "react-dom/client";
import React, {
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";

const WS_URL =
	"wss://durable-chat-template1.m-jagodzinski83.workers.dev/parties/chat/sink";

const FIRMWARE_URL =
	"https://truck-dw9.pages.dev/firmware/sink/firmware.bin";

const VERSION_URL =
	"https://truck-dw9.pages.dev/firmware/sink/version.json";

type WsMessage = {
	type?: string;
	message?: string;
	online?: boolean;
	data?: {
		fw_version?: string;
		ota_running?: boolean;
		ota_progress?: number;
		[key: string]: unknown;
	};
	[key: string]: unknown;
};

function App() {
	const socketRef = useRef<WebSocket | null>(null);

	const [panelToken, setPanelToken] = useState(
		() => sessionStorage.getItem("truck_panel_token") ?? "",
	);

	const [connected, setConnected] = useState(false);
	const [authorized, setAuthorized] = useState(false);
	const [deviceOnline, setDeviceOnline] = useState(false);

	const [status, setStatus] = useState("Niepołączony");
	const [firmwareVersion, setFirmwareVersion] = useState("—");
	const [availableVersion, setAvailableVersion] = useState("—");
	const [versionLoadError, setVersionLoadError] = useState(false);

	const [otaRunning, setOtaRunning] = useState(false);
	const [otaProgress, setOtaProgress] = useState(0);

	const [lastTelemetryAt, setLastTelemetryAt] = useState(0);
	const [lastMessage, setLastMessage] = useState("");

	const disconnect = useCallback(() => {
		const ws = socketRef.current;
		socketRef.current = null;

		if (ws) {
			try {
				ws.close();
			} catch {
				// ignore
			}
		}

		setConnected(false);
		setAuthorized(false);
		setDeviceOnline(false);
		setStatus("Niepołączony");
	}, []);

	const connect = useCallback(
		(tokenOverride?: string) => {
			const token = (tokenOverride ?? panelToken).trim();

			if (!token) {
				setStatus("Wpisz PANEL_TOKEN");
				return;
			}

			sessionStorage.setItem("truck_panel_token", token);

			if (socketRef.current) {
				try {
					socketRef.current.close();
				} catch {
					// ignore
				}
			}

			setStatus("Łączenie...");
			setConnected(false);
			setAuthorized(false);
			setDeviceOnline(false);

			const ws = new WebSocket(WS_URL);
			socketRef.current = ws;

			ws.onopen = () => {
				if (socketRef.current !== ws) return;

				setConnected(true);
				setStatus("Połączono z Cloudflare — autoryzacja...");

				ws.send(
					JSON.stringify({
						type: "auth",
						role: "panel",
						token,
					}),
				);
			};

			ws.onmessage = (event) => {
				if (socketRef.current !== ws) return;

				const raw = String(event.data);
				setLastMessage(raw);

				let message: WsMessage;

				try {
					message = JSON.parse(raw) as WsMessage;
				} catch {
					return;
				}

				if (message.type === "auth_ok") {
					setAuthorized(true);
					setStatus("CLOUD OK");

					// Pobierz aktualne dane urządzenia od razu po logowaniu.
					ws.send(
						JSON.stringify({
							type: "get_data",
						}),
					);

					return;
				}

				if (
					message.type === "auth_error" ||
					message.type === "unauthorized"
				) {
					setAuthorized(false);
					setStatus("Błędny PANEL_TOKEN");
					return;
				}

				if (message.type === "telemetry" && message.data) {
					setDeviceOnline(true);
					setLastTelemetryAt(Date.now());

					if (typeof message.data.fw_version === "string") {
						setFirmwareVersion(message.data.fw_version);
					}

					if (typeof message.data.ota_running === "boolean") {
						setOtaRunning(message.data.ota_running);
					}

					if (typeof message.data.ota_progress === "number") {
						setOtaProgress(message.data.ota_progress);
					}

					return;
				}

				if (message.type === "device_status") {
					if (typeof message.online === "boolean") {
						setDeviceOnline(message.online);
					}
				}
			};

			ws.onerror = () => {
				if (socketRef.current !== ws) return;
				setStatus("Błąd WebSocket");
			};

			ws.onclose = () => {
				if (socketRef.current !== ws) return;

				socketRef.current = null;
				setConnected(false);
				setAuthorized(false);
				setDeviceOnline(false);
				setStatus("Rozłączono");
			};
		},
		[panelToken],
	);

	useEffect(() => {
		if (panelToken.trim()) {
			connect(panelToken);
		}

		return () => {
			const ws = socketRef.current;
			socketRef.current = null;

			if (ws) {
				try {
					ws.close();
				} catch {
					// ignore
				}
			}
		};
		// Uruchamiamy tylko przy starcie strony.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	useEffect(() => {
		let cancelled = false;

		const loadAvailableVersion = async () => {
			try {
				const response = await fetch(
					`${VERSION_URL}?t=${Date.now()}`,
					{ cache: "no-store" },
				);

				if (!response.ok) {
					throw new Error(`HTTP ${response.status}`);
				}

				const data = (await response.json()) as {
					version?: unknown;
				};

				if (
					typeof data.version !== "string" ||
					!data.version.trim()
				) {
					throw new Error("Brak pola version");
				}

				if (!cancelled) {
					setAvailableVersion(data.version.trim());
					setVersionLoadError(false);
				}
			} catch {
				if (!cancelled) {
					setAvailableVersion("—");
					setVersionLoadError(true);
				}
			}
		};

		void loadAvailableVersion();

		const timer = window.setInterval(
			loadAvailableVersion,
			60000,
		);

		return () => {
			cancelled = true;
			window.clearInterval(timer);
		};
	}, []);

	useEffect(() => {
		const timer = window.setInterval(() => {
			if (
				lastTelemetryAt > 0 &&
				Date.now() - lastTelemetryAt > 15000
			) {
				setDeviceOnline(false);
			}
		}, 2000);

		return () => window.clearInterval(timer);
	}, [lastTelemetryAt]);

	const requestData = () => {
		const ws = socketRef.current;

		if (
			!ws ||
			ws.readyState !== WebSocket.OPEN ||
			!authorized
		) {
			return;
		}

		ws.send(
			JSON.stringify({
				type: "get_data",
			}),
		);
	};

	const installUpdate = () => {
		const ws = socketRef.current;

		if (
			!ws ||
			ws.readyState !== WebSocket.OPEN ||
			!authorized ||
			!deviceOnline
		) {
			return;
		}

		const confirmed = window.confirm(
			`Zainstalować firmware ${availableVersion}?\n\n` +
				"ESP pobierze firmware, zapisze go i uruchomi się ponownie.",
		);

		if (!confirmed) return;

		ws.send(
			JSON.stringify({
				type: "command",
				cmd: "install_update",
			}),
		);

		setStatus("Wysłano polecenie aktualizacji");
	};

	const compareVersions = (a: string, b: string) => {
		const parse = (value: string) =>
			value
				.replace(/^v/i, "")
				.split(".")
				.map((part) => Number.parseInt(part, 10) || 0);

		const av = parse(a);
		const bv = parse(b);
		const maxLength = Math.max(av.length, bv.length);

		for (let i = 0; i < maxLength; i += 1) {
			const left = av[i] ?? 0;
			const right = bv[i] ?? 0;

			if (left > right) return 1;
			if (left < right) return -1;
		}

		return 0;
	};

	const cloudColor = authorized ? "#198754" : "#dc3545";
	const deviceColor = deviceOnline ? "#198754" : "#dc3545";

	const deviceVersionKnown = firmwareVersion !== "—";
	const serverVersionKnown = availableVersion !== "—";

	const versionComparison =
		deviceVersionKnown && serverVersionKnown
			? compareVersions(firmwareVersion, availableVersion)
			: null;

	const hasUpdate = versionComparison === -1;
	const isCurrentVersion = versionComparison === 0;
	const serverIsOlder = versionComparison === 1;

	return (
		<div
			style={{
				maxWidth: 760,
				margin: "40px auto",
				padding: 20,
				fontFamily:
					"system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
			}}
		>
			<h1 style={{ marginBottom: 8 }}>TRUCK — OTA</h1>

			<p style={{ marginTop: 0, opacity: 0.7 }}>
				Zdalna aktualizacja sterownika ESP32-C3
			</p>

			<div
				style={{
					border: "1px solid #ccc",
					borderRadius: 10,
					padding: 18,
					marginBottom: 18,
				}}
			>
				<h2 style={{ marginTop: 0 }}>Połączenie</h2>

				<label
					htmlFor="panel-token"
					style={{
						display: "block",
						marginBottom: 6,
						fontWeight: 600,
					}}
				>
					PANEL_TOKEN
				</label>

				<div
					style={{
						display: "flex",
						gap: 8,
						flexWrap: "wrap",
					}}
				>
					<input
						id="panel-token"
						type="password"
						value={panelToken}
						onChange={(e) => setPanelToken(e.target.value)}
						placeholder="Wpisz PANEL_TOKEN"
						autoComplete="off"
						style={{
							flex: "1 1 320px",
							padding: "10px 12px",
							fontSize: 16,
						}}
					/>

					<button
						type="button"
						onClick={() => connect()}
						style={{
							padding: "10px 16px",
							cursor: "pointer",
						}}
					>
						Połącz
					</button>

					<button
						type="button"
						onClick={disconnect}
						disabled={!connected}
						style={{
							padding: "10px 16px",
							cursor: connected ? "pointer" : "default",
						}}
					>
						Rozłącz
					</button>
				</div>

				<p style={{ marginBottom: 0 }}>
					Status: <strong>{status}</strong>
				</p>

				<div
					style={{
						display: "flex",
						gap: 20,
						marginTop: 12,
						flexWrap: "wrap",
					}}
				>
					<div>
						<span
							style={{
								display: "inline-block",
								width: 10,
								height: 10,
								borderRadius: "50%",
								background: cloudColor,
								marginRight: 6,
							}}
						/>
						Cloudflare: {authorized ? "OK" : "OFFLINE"}
					</div>

					<div>
						<span
							style={{
								display: "inline-block",
								width: 10,
								height: 10,
								borderRadius: "50%",
								background: deviceColor,
								marginRight: 6,
							}}
						/>
						ESP32: {deviceOnline ? "ONLINE" : "OFFLINE"}
					</div>
				</div>
			</div>

			<div
				style={{
					border: "1px solid #ccc",
					borderRadius: 10,
					padding: 18,
				}}
			>
				<h2 style={{ marginTop: 0 }}>Aktualizacja</h2>

				<div
					style={{
						padding: "12px 14px",
						borderRadius: 8,
						marginBottom: 16,
						fontWeight: 700,
						background: isCurrentVersion
							? "#e9f7ef"
							: hasUpdate
								? "#fff4e5"
								: "#f3f3f3",
						color: isCurrentVersion
							? "#146c43"
							: hasUpdate
								? "#9a6700"
								: "#555",
					}}
				>
					{versionLoadError
						? "BŁĄD ODCZYTU VERSION.JSON"
						: isCurrentVersion
							? `MASZ AKTUALNĄ WERSJĘ ${firmwareVersion}`
							: hasUpdate
								? `DOSTĘPNA AKTUALIZACJA: ${firmwareVersion} → ${availableVersion}`
								: serverIsOlder
									? `UWAGA: FIRMWARE NA SERWERZE JEST STARSZY (${availableVersion})`
									: "OCZEKIWANIE NA INFORMACJĘ O WERSJI..."}
				</div>

				<table
					style={{
						width: "100%",
						borderCollapse: "collapse",
						marginBottom: 18,
					}}
				>
					<tbody>
						<tr>
							<td style={{ padding: "6px 0" }}>
								Wersja w ESP32
							</td>
							<td
								style={{
									padding: "6px 0",
									textAlign: "right",
									fontWeight: 700,
								}}
							>
								{firmwareVersion}
							</td>
						</tr>

						<tr>
							<td style={{ padding: "6px 0" }}>
								Firmware na serwerze
							</td>
							<td
								style={{
									padding: "6px 0",
									textAlign: "right",
									fontWeight: 700,
								}}
							>
								{availableVersion}
							</td>
						</tr>

						<tr>
							<td style={{ padding: "6px 0" }}>
								OTA
							</td>
							<td
								style={{
									padding: "6px 0",
									textAlign: "right",
								}}
							>
								{otaRunning
									? `AKTUALIZACJA ${otaProgress}%`
									: "Gotowe"}
							</td>
						</tr>
					</tbody>
				</table>

				<div
					style={{
						display: "flex",
						gap: 10,
						flexWrap: "wrap",
					}}
				>
					<button
						type="button"
						onClick={requestData}
						disabled={!authorized}
						style={{
							padding: "12px 16px",
							fontSize: 16,
							cursor: authorized ? "pointer" : "default",
						}}
					>
						Odśwież dane
					</button>

					<button
						type="button"
						onClick={installUpdate}
						disabled={
							!authorized ||
							!deviceOnline ||
							otaRunning ||
							!hasUpdate
						}
						style={{
							padding: "12px 20px",
							fontSize: 16,
							fontWeight: 700,
							cursor:
								authorized &&
								deviceOnline &&
								!otaRunning &&
								hasUpdate
									? "pointer"
									: "default",
						}}
					>
						{isCurrentVersion
							? "MASZ AKTUALNĄ WERSJĘ"
							: hasUpdate
								? "ZAINSTALUJ AKTUALIZACJĘ"
								: "AKTUALIZACJA NIEDOSTĘPNA"}
					</button>
				</div>

				<p
					style={{
						marginTop: 18,
						marginBottom: 0,
						fontSize: 13,
						opacity: 0.7,
						wordBreak: "break-all",
					}}
				>
					Firmware: {FIRMWARE_URL}
					<br />
					Wersja: {VERSION_URL}
				</p>
			</div>

			<details style={{ marginTop: 18 }}>
				<summary>Ostatnia wiadomość diagnostyczna</summary>
				<pre
					style={{
						whiteSpace: "pre-wrap",
						wordBreak: "break-word",
						fontSize: 12,
						padding: 10,
						background: "#f3f3f3",
					}}
				>
					{lastMessage || "Brak"}
				</pre>
			</details>
		</div>
	);
}

// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
createRoot(document.getElementById("root")!).render(<App />);
