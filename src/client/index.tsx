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

type Telemetry = {
	water_l?: number;
	water_percent?: number;
	distance_cm?: number;
	water_ok?: boolean;

	temperature_c?: number;
	temperature_ok?: boolean;

	battery_v?: number;
	current_a?: number;
	power_w?: number;
	ina238_ok?: boolean;

	rtc_ok?: boolean;
	hour?: number;
	minute?: number;

	wifi_rssi?: number;
	fw_version?: string;

	ota_running?: boolean;
	ota_progress?: number;

	[key: string]: unknown;
};

type WsMessage = {
	type?: string;
	message?: string;
	online?: boolean;
	data?: Telemetry;
	[key: string]: unknown;
};

const CARD: React.CSSProperties = {
	background: "#1f1f20",
	border: "1px solid #343436",
	borderRadius: 18,
	padding: 20,
	boxShadow: "0 8px 28px rgba(0,0,0,.16)",
};

const LABEL: React.CSSProperties = {
	fontSize: 13,
	letterSpacing: ".06em",
	color: "#b9c8d8",
	marginBottom: 10,
};

const VALUE: React.CSSProperties = {
	fontSize: "clamp(28px, 5vw, 46px)",
	fontWeight: 800,
	lineHeight: 1,
	color: "#f6f6f6",
};

const SUB: React.CSSProperties = {
	marginTop: 10,
	color: "#c4c4c8",
	fontSize: 15,
};

function fmt(value: number | undefined, digits = 1) {
	return typeof value === "number" && Number.isFinite(value)
		? value.toFixed(digits)
		: "—";
}

function clamp(value: number, min: number, max: number) {
	return Math.max(min, Math.min(max, value));
}

function App() {
	const socketRef = useRef<WebSocket | null>(null);

	const [panelToken, setPanelToken] = useState(
		() => sessionStorage.getItem("truck_panel_token") ?? "",
	);

	const [connected, setConnected] = useState(false);
	const [authorized, setAuthorized] = useState(false);
	const [deviceOnline, setDeviceOnline] = useState(false);
	const [status, setStatus] = useState("Niepołączony");

	const [telemetry, setTelemetry] = useState<Telemetry>({});
	const [lastTelemetryAt, setLastTelemetryAt] = useState(0);

	const [firmwareVersion, setFirmwareVersion] = useState("—");
	const [availableVersion, setAvailableVersion] = useState("—");
	const [versionLoadError, setVersionLoadError] = useState(false);

	const [otaRunning, setOtaRunning] = useState(false);
	const [otaProgress, setOtaProgress] = useState(0);

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
				setStatus("Autoryzacja...");

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
					const data = message.data;

					setTelemetry(data);
					setDeviceOnline(true);
					setLastTelemetryAt(Date.now());

					if (typeof data.fw_version === "string") {
						setFirmwareVersion(data.fw_version);
					}

					if (typeof data.ota_running === "boolean") {
						setOtaRunning(data.ota_running);
					}

					if (typeof data.ota_progress === "number") {
						setOtaProgress(data.ota_progress);
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
			!deviceOnline ||
			!hasUpdate
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

	const deviceVersionKnown = firmwareVersion !== "—";
	const serverVersionKnown = availableVersion !== "—";

	const versionComparison =
		deviceVersionKnown && serverVersionKnown
			? compareVersions(firmwareVersion, availableVersion)
			: null;

	const hasUpdate = versionComparison === -1;
	const isCurrentVersion = versionComparison === 0;
	const serverIsOlder = versionComparison === 1;

	const waterPercent =
		typeof telemetry.water_percent === "number"
			? clamp(telemetry.water_percent, 0, 100)
			: 0;

	const waterColor =
		waterPercent <= 10
			? "#ff5b62"
			: waterPercent <= 20
				? "#ffd166"
				: "#f5f5f5";

	const lastReadText =
		lastTelemetryAt > 0
			? new Date(lastTelemetryAt).toLocaleTimeString("pl-PL")
			: "—";

	const rtcText =
		telemetry.rtc_ok &&
		typeof telemetry.hour === "number" &&
		typeof telemetry.minute === "number"
			? `${String(telemetry.hour).padStart(2, "0")}:${String(
					telemetry.minute,
				).padStart(2, "0")}`
			: "—";

	return (
		<div
			style={{
				minHeight: "100vh",
				background: "#0f0f10",
				color: "#f5f5f5",
				fontFamily:
					"system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
			}}
		>
			<div
				style={{
					width: "min(1100px, calc(100% - 28px))",
					margin: "0 auto",
					padding: "20px 0 36px",
				}}
			>
				<header
					style={{
						display: "flex",
						alignItems: "center",
						justifyContent: "space-between",
						gap: 12,
						marginBottom: 18,
					}}
				>
					<div>
						<h1
							style={{
								margin: 0,
								fontSize: "clamp(26px, 4vw, 38px)",
								lineHeight: 1,
							}}
						>
							Truck Controller
						</h1>
						<div
							style={{
								marginTop: 7,
								color: "#99999f",
								fontSize: 13,
								display: "flex",
								gap: 10,
								flexWrap: "wrap",
							}}
						>
							<span>ESP32-C3</span>
							<span>•</span>
							<span>
								Bieżąca wersja:{" "}
								<strong style={{ color: "#f5f5f5" }}>
									{firmwareVersion}
								</strong>
							</span>
						</div>
					</div>

					<div
						style={{
							padding: "8px 14px",
							borderRadius: 999,
							background: deviceOnline ? "#123f27" : "#461d20",
							color: deviceOnline ? "#b8f7cf" : "#ffb4b9",
							fontWeight: 700,
							whiteSpace: "nowrap",
						}}
					>
						{deviceOnline ? "Truck online" : "Truck offline"}
					</div>
				</header>

				{/* WODA */}
				<section style={{ ...CARD, marginBottom: 16 }}>
					<div style={LABEL}>WODA CZYSTA</div>

					<div style={{ ...VALUE, color: waterColor }}>
						{fmt(telemetry.water_l, 1)} L
					</div>

					<div style={SUB}>
						{fmt(telemetry.water_percent, 0)}% ·{" "}
						{fmt(telemetry.distance_cm, 1)} cm
					</div>

					<div
						style={{
							height: 14,
							background: "#3b3b3e",
							borderRadius: 999,
							overflow: "hidden",
							marginTop: 16,
						}}
					>
						<div
							style={{
								height: "100%",
								width: `${waterPercent}%`,
								background: waterColor,
								borderRadius: 999,
								transition: "width .25s ease",
							}}
						/>
					</div>
				</section>

				{/* TELEMETRIA */}
				<div
					style={{
						display: "grid",
						gridTemplateColumns:
							"repeat(auto-fit, minmax(250px, 1fr))",
						gap: 14,
						marginBottom: 16,
					}}
				>
					<section style={CARD}>
						<div style={LABEL}>AKUMULATOR</div>
						<div style={VALUE}>
							{fmt(telemetry.battery_v, 2)} V
						</div>
						<div style={SUB}>
							{fmt(telemetry.current_a, 2)} A ·{" "}
							{fmt(telemetry.power_w, 1)} W
						</div>
					</section>

					<section style={CARD}>
						<div style={LABEL}>TEMPERATURA</div>
						<div style={VALUE}>
							{telemetry.temperature_ok === false
								? "—"
								: fmt(telemetry.temperature_c, 1)}
							{" "}°C
						</div>
						<div style={SUB}>
							{telemetry.temperature_ok === false
								? "brak / błąd czujnika"
								: "DS18B20"}
						</div>
					</section>

					<section style={CARD}>
						<div style={LABEL}>WI-FI ESP32</div>
						<div style={VALUE}>
							{typeof telemetry.wifi_rssi === "number"
								? telemetry.wifi_rssi
								: "—"}
						</div>
						<div style={SUB}>dBm</div>
					</section>

					<section style={CARD}>
						<div style={LABEL}>RTC</div>
						<div style={VALUE}>{rtcText}</div>
						<div style={SUB}>
							{telemetry.rtc_ok === false
								? "błąd zegara"
								: `ostatni odczyt: ${lastReadText}`}
						</div>
					</section>
				</div>

				{/* OTA */}
				<section style={{ ...CARD, marginBottom: 16 }}>
					<div style={LABEL}>OPROGRAMOWANIE</div>

					<div
						style={{
							display: "grid",
							gridTemplateColumns:
								"repeat(auto-fit, minmax(200px, 1fr))",
							gap: 14,
							alignItems: "end",
						}}
					>
						<div>
							<div
								style={{
									fontSize: 30,
									fontWeight: 800,
								}}
							>
								{firmwareVersion}
							</div>
							<div style={SUB}>
								Najnowsza: <b>{availableVersion}</b>
							</div>
						</div>

						<div
							style={{
								padding: "12px 14px",
								borderRadius: 10,
								background: isCurrentVersion
									? "#123f27"
									: hasUpdate
										? "#4b3a12"
										: serverIsOlder
											? "#461d20"
											: "#29292b",
								color: isCurrentVersion
									? "#b8f7cf"
									: hasUpdate
										? "#ffe29a"
										: serverIsOlder
											? "#ffb4b9"
											: "#c7c7ca",
								fontWeight: 700,
							}}
						>
							{versionLoadError
								? "BŁĄD ODCZYTU VERSION.JSON"
								: isCurrentVersion
									? "MASZ NAJNOWSZĄ WERSJĘ"
									: hasUpdate
										? `DOSTĘPNA AKTUALIZACJA ${firmwareVersion} → ${availableVersion}`
										: serverIsOlder
											? "FIRMWARE NA SERWERZE JEST STARSZY"
											: "OCZEKIWANIE NA WERSJĘ"}
						</div>
					</div>

					<div
						style={{
							height: 10,
							background: "#3b3b3e",
							borderRadius: 999,
							overflow: "hidden",
							marginTop: 18,
						}}
					>
						<div
							style={{
								height: "100%",
								width: `${clamp(otaProgress, 0, 100)}%`,
								background: "#f5f5f5",
								borderRadius: 999,
							}}
						/>
					</div>

					<div style={{ ...SUB, marginTop: 8 }}>
						{otaRunning
							? `Aktualizacja ${otaProgress}%`
							: "Gotowy"}
					</div>

					<div
						style={{
							display: "flex",
							gap: 10,
							flexWrap: "wrap",
							marginTop: 14,
						}}
					>
						<button
							type="button"
							onClick={requestData}
							disabled={!authorized}
							style={{
								padding: "12px 18px",
								borderRadius: 10,
								border: "1px solid #4b4b4f",
								background: "#29292b",
								color: "#f5f5f5",
								fontWeight: 700,
								cursor: authorized ? "pointer" : "default",
								opacity: authorized ? 1 : 0.45,
							}}
						>
							ODŚWIEŻ DANE
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
								flex: "1 1 300px",
								padding: "12px 18px",
								borderRadius: 10,
								border: 0,
								background: hasUpdate
									? "#f2f2f2"
									: "#37373a",
								color: hasUpdate
									? "#111"
									: "#8f8f94",
								fontWeight: 800,
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
								? "MASZ NAJNOWSZĄ WERSJĘ"
								: hasUpdate
									? "ZAINSTALUJ AKTUALIZACJĘ"
									: "AKTUALIZACJA NIEDOSTĘPNA"}
						</button>
					</div>
				</section>

				{/* POŁĄCZENIE */}
				<details
					style={{
						...CARD,
						marginBottom: 16,
					}}
				>
					<summary
						style={{
							cursor: "pointer",
							fontWeight: 700,
							color: "#f5f5f5",
						}}
					>
						Połączenie / PANEL_TOKEN
					</summary>

					<div style={{ marginTop: 16 }}>
						<div
							style={{
								display: "flex",
								gap: 8,
								flexWrap: "wrap",
							}}
						>
							<input
								type="password"
								value={panelToken}
								onChange={(e) =>
									setPanelToken(e.target.value)
								}
								placeholder="PANEL_TOKEN"
								autoComplete="off"
								style={{
									flex: "1 1 320px",
									padding: "12px 14px",
									fontSize: 16,
									background: "#111112",
									color: "#f5f5f5",
									border: "1px solid #454548",
									borderRadius: 10,
									outline: "none",
								}}
							/>

							<button
								type="button"
								onClick={() => connect()}
								style={{
									padding: "11px 16px",
									border: 0,
									borderRadius: 10,
									background: "#f1f1f1",
									color: "#111",
									fontWeight: 700,
									cursor: "pointer",
								}}
							>
								POŁĄCZ
							</button>

							<button
								type="button"
								onClick={disconnect}
								disabled={!connected}
								style={{
									padding: "11px 16px",
									borderRadius: 10,
									border: "1px solid #4a4a4d",
									background: "#29292b",
									color: "#f5f5f5",
									opacity: connected ? 1 : 0.45,
									cursor: connected
										? "pointer"
										: "default",
								}}
							>
								ROZŁĄCZ
							</button>
						</div>

						<div style={{ marginTop: 12, color: "#c7c7ca" }}>
							Status: <b>{status}</b>
						</div>

						<div
							style={{
								display: "flex",
								gap: 18,
								flexWrap: "wrap",
								marginTop: 10,
							}}
						>
							<span>
								<span
									style={{
										color: authorized
											? "#5dde8a"
											: "#ff5b62",
									}}
								>
									●
								</span>{" "}
								Cloudflare: {authorized ? "OK" : "OFFLINE"}
							</span>

							<span>
								<span
									style={{
										color: deviceOnline
											? "#5dde8a"
											: "#ff5b62",
									}}
								>
									●
								</span>{" "}
								ESP32: {deviceOnline ? "ONLINE" : "OFFLINE"}
							</span>
						</div>
					</div>
				</details>

				<details
					style={{
						...CARD,
						padding: "14px 16px",
					}}
				>
					<summary
						style={{
							cursor: "pointer",
							fontWeight: 700,
						}}
					>
						Diagnostyka
					</summary>

					<pre
						style={{
							whiteSpace: "pre-wrap",
							wordBreak: "break-word",
							fontSize: 12,
							padding: 12,
							background: "#111112",
							color: "#d8d8dc",
							borderRadius: 10,
							marginBottom: 0,
						}}
					>
						{lastMessage || "Brak"}
					</pre>

					<div
						style={{
							marginTop: 10,
							fontSize: 12,
							color: "#8f8f94",
							wordBreak: "break-all",
						}}
					>
						Firmware: {FIRMWARE_URL}
						<br />
						Wersja: {VERSION_URL}
					</div>
				</details>
			</div>
		</div>
	);
}

// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
createRoot(document.getElementById("root")!).render(<App />);
