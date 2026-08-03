import {
	type Connection,
	Server,
	type WSMessage,
	routePartykitRequest,
} from "partyserver";

type Role = "device" | "panel";

type ClientState = {
	authenticated: boolean;
	role: Role | null;
};

type Secrets = {
	DEVICE_TOKEN?: string;
	PANEL_TOKEN?: string;
};

export class Chat extends Server<Env> {
	static options = { hibernate: true };

	private sendJson(
		connection: Connection,
		data: unknown,
	) {
		connection.send(JSON.stringify(data));
	}

	private broadcastToRole(
		role: Role,
		data: unknown,
		excludeId?: string,
	) {
		const text = JSON.stringify(data);

		for (const connection of this.getConnections()) {
			if (connection.id === excludeId) {
				continue;
			}

			const state =
				connection.state as ClientState | null;

			if (
				state?.authenticated &&
				state.role === role
			) {
				connection.send(text);
			}
		}
	}

	private deviceOnline(
		excludeId?: string,
	): boolean {
		for (const connection of this.getConnections()) {
			if (connection.id === excludeId) {
				continue;
			}

			const state =
				connection.state as ClientState | null;

			if (
				state?.authenticated &&
				state.role === "device"
			) {
				return true;
			}
		}

		return false;
	}

	onConnect(connection: Connection) {
		connection.setState({
			authenticated: false,
			role: null,
		} satisfies ClientState);
	}

	onMessage(
		connection: Connection,
		message: WSMessage,
	) {
		if (typeof message !== "string") {
			this.sendJson(connection, {
				type: "error",
				error: "text_only",
			});

			return;
		}

		let packet: any;

		try {
			packet = JSON.parse(message);
		} catch {
			this.sendJson(connection, {
				type: "error",
				error: "invalid_json",
			});

			return;
		}

		const state =
			connection.state as ClientState | null;

		// =========================================
		// AUTORYZACJA
		// =========================================

		if (!state?.authenticated) {
			if (packet.type !== "auth") {
				this.sendJson(connection, {
					type: "error",
					error: "auth_required",
				});

				connection.close(
					1008,
					"Authentication required",
				);

				return;
			}

			const role: Role | null =
				packet.role === "device" ||
				packet.role === "panel"
					? packet.role
					: null;

			const secrets =
				this.env as unknown as Secrets;

			const expectedToken =
				role === "device"
					? secrets.DEVICE_TOKEN
					: role === "panel"
						? secrets.PANEL_TOKEN
						: undefined;

			if (
				!role ||
				!expectedToken ||
				typeof packet.token !== "string" ||
				packet.token !== expectedToken
			) {
				this.sendJson(connection, {
					type: "error",
					error: "auth_failed",
				});

				connection.close(
					1008,
					"Authentication failed",
				);

				return;
			}

			connection.setState({
				authenticated: true,
				role,
			} satisfies ClientState);

			this.sendJson(connection, {
				type: "auth_ok",
				role,
			});

			if (role === "device") {
				this.broadcastToRole(
					"panel",
					{
						type: "device_status",
						online: true,
					},
				);
			}

			if (role === "panel") {
				this.sendJson(connection, {
					type: "device_status",
					online: this.deviceOnline(),
				});
			}

			return;
		}

		// =========================================
		// PANEL -> ESP32
		// =========================================

		if (
			state.role === "panel" &&
			packet.type === "get_data"
		) {
			this.broadcastToRole(
				"device",
				{
					type: "get_data",
				},
			);

			return;
		}

		if (
			state.role === "panel" &&
			packet.type === "command"
		) {
			this.broadcastToRole(
				"device",
				{
					type: "command",
					cmd: packet.cmd,
					value: packet.value,
				},
			);

			return;
		}

		// =========================================
		// ESP32 -> PANEL
		// =========================================

		if (
			state.role === "device" &&
			packet.type === "telemetry"
		) {
			this.broadcastToRole(
				"panel",
				packet,
			);

			return;
		}

		if (
			state.role === "device" &&
			packet.type === "state"
		) {
			this.broadcastToRole(
				"panel",
				packet,
			);

			return;
		}

		this.sendJson(connection, {
			type: "error",
			error: "unsupported_message",
		});
	}

	onClose(connection: Connection) {
		const state =
			connection.state as ClientState | null;

		if (
			state?.authenticated &&
			state.role === "device"
		) {
			this.broadcastToRole(
				"panel",
				{
					type: "device_status",
					online: this.deviceOnline(
						connection.id,
					),
				},
			);
		}
	}
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);

		if (url.pathname === "/health") {
			return Response.json({
				ok: true,
				service: "truck-relay",
			});
		}

		return (
			(await routePartykitRequest(
				request,
				{ ...env },
			)) ||
			env.ASSETS.fetch(request)
		);
	},
} satisfies ExportedHandler<Env>;
