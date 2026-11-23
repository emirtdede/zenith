//! Model Context Protocol server over stdio (JSON-RPC 2.0).
//!
//! The MCP surface exists so an assistant or an editor can ask Zenith what it
//! measured without a second, weaker code path. Three rules shape it:
//!
//! * **Read-only.** The two tools list the action catalogue and run the same
//!   probes the GUI runs. There is no tool that mutates the machine: an
//!   assistant that can silently repair a computer is a remote code execution
//!   surface with a friendly schema.
//! * **Line-delimited JSON.** One request per line, one response per line, no
//!   framing and no session state. A client that dies leaves nothing behind.
//! * **The protocol is data, not a library.** Everything below is a pure
//!   function over `serde_json::Value`, so the tests drive real frames without a
//!   pipe and without a model.
//!
//! `serve_stdio` is a thin loop over `handle_line`; it is the only part that
//! touches a stream.

use std::io::{BufRead, Write};

use serde_json::{Value, json};

/// The protocol revision this server implements. A client that asks for an
/// older revision still works: the reply states what is implemented rather than
/// pretending to negotiate a feature set that does not exist.
pub const PROTOCOL_VERSION: &str = "2025-06-18";

/// One action, reduced to what a tool result may disclose.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolAction {
    pub id: &'static str,
    pub name_key: String,
    pub risk: &'static str,
    pub tier: &'static str,
}

/// What the MCP tools are allowed to reach. The implementation lives beside the
/// probe harness so the server cannot grow a capability the interface does not
/// have.
pub trait ToolHost {
    fn list_actions(&self) -> Vec<ToolAction>;
    fn diagnose(&self) -> Result<Value, String>;
}

// JSON-RPC 2.0 error codes.
const PARSE_ERROR: i64 = -32700;
const INVALID_REQUEST: i64 = -32600;
const METHOD_NOT_FOUND: i64 = -32601;
const INVALID_PARAMS: i64 = -32602;

fn error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn success(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

/// Dispatch one already-parsed frame. Returns `None` for a notification, which
/// by definition has no reply.
pub fn handle_value(request: &Value, host: &dyn ToolHost) -> Option<Value> {
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let is_notification = request.get("id").is_none();
    if request.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return Some(error(id, INVALID_REQUEST, "jsonrpc must be \"2.0\""));
    }
    let Some(method) = request.get("method").and_then(Value::as_str) else {
        return Some(error(id, INVALID_REQUEST, "method is required"));
    };

    let params = request.get("params").cloned().unwrap_or(Value::Null);

    let reply = match method {
        "initialize" => Some(success(
            id,
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "serverInfo": { "name": "zenith", "version": crate::VERSION },
                "capabilities": { "tools": { "listChanged": false } },
                "instructions": "Read-only access to Zenith's measured state. No tool mutates the machine."
            }),
        )),
        "ping" => Some(success(id, json!({}))),
        "tools/list" => Some(success(id, json!({ "tools": tool_list() }))),
        "tools/call" => Some(call_tool(id, &params, host)),
        // The client confirms the handshake with a notification; an older client
        // may send `initialized` as a request, which is answered with an empty
        // result rather than an error.
        "notifications/initialized" | "initialized" => Some(success(id, json!({}))),
        _ => Some(error(id, METHOD_NOT_FOUND, "method not found")),
    };

    if is_notification { None } else { reply }
}

fn tool_list() -> Value {
    json!([
        {
            "name": "zenith_list_actions",
            "description": "List the repair actions this build offers, with the reversibility tier and risk each one declares. Read-only.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        },
        {
            "name": "zenith_diagnose",
            "description": "Run the same read-only probes the application's diagnosis runs, and return the measured reports. Read-only; no repair is performed.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        }
    ])
}

fn call_tool(id: Value, params: &Value, host: &dyn ToolHost) -> Value {
    let Some(name) = params.get("name").and_then(Value::as_str) else {
        return error(id, INVALID_PARAMS, "params.name is required");
    };
    match name {
        "zenith_list_actions" => {
            let actions: Vec<Value> = host
                .list_actions()
                .into_iter()
                .map(|action| {
                    json!({
                        "id": action.id,
                        "nameKey": action.name_key,
                        "risk": action.risk,
                        "tier": action.tier,
                    })
                })
                .collect();
            tool_result(id, json!({ "actions": actions }), false)
        }
        "zenith_diagnose" => match host.diagnose() {
            Ok(reports) => tool_result(id, reports, false),
            Err(detail) => tool_result(id, json!({ "error": detail }), true),
        },
        other => error(id, INVALID_PARAMS, &format!("unknown tool: {other}")),
    }
}

fn tool_result(id: Value, value: Value, is_error: bool) -> Value {
    success(
        id,
        json!({
            "content": [{ "type": "text", "text": value.to_string() }],
            "isError": is_error,
        }),
    )
}

/// One line in, at most one line out.
pub fn handle_line(line: &str, host: &dyn ToolHost) -> Option<String> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    let request: Value = match serde_json::from_str(trimmed) {
        Ok(value) => value,
        Err(_) => return Some(error(Value::Null, PARSE_ERROR, "parse error").to_string()),
    };
    handle_value(&request, host).map(|reply| reply.to_string())
}

/// Serve until end of input. A write failure ends the loop: a closed pipe is not
/// a protocol error, and there is nobody left to tell.
pub fn serve_stdio(
    host: &dyn ToolHost,
    input: &mut dyn BufRead,
    output: &mut dyn Write,
) -> std::io::Result<u64> {
    let mut served = 0u64;
    let mut line = String::new();
    loop {
        line.clear();
        let read = input.read_line(&mut line)?;
        if read == 0 {
            return Ok(served);
        }
        if let Some(reply) = handle_line(&line, host) {
            writeln!(output, "{reply}")?;
            output.flush()?;
            served += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Host;

    impl ToolHost for Host {
        fn list_actions(&self) -> Vec<ToolAction> {
            vec![ToolAction {
                id: "flush-dns",
                name_key: "actions.flush-dns.name".to_string(),
                risk: "low",
                tier: "reversible",
            }]
        }

        fn diagnose(&self) -> Result<Value, String> {
            Ok(json!({ "reports": [{ "probe": "memory", "status": "ok" }] }))
        }
    }

    fn call(frame: &str) -> Value {
        let reply = handle_line(frame, &Host).expect("a reply");
        serde_json::from_str(&reply).expect("valid JSON reply")
    }

    #[test]
    fn initialize_states_a_protocol_version_and_a_read_only_capability() {
        let reply = call(r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#);
        assert_eq!(reply["result"]["protocolVersion"], PROTOCOL_VERSION);
        assert_eq!(reply["result"]["serverInfo"]["name"], "zenith");
        assert!(reply["result"]["capabilities"]["tools"].is_object());
        assert!(
            reply["result"]["instructions"]
                .as_str()
                .is_some_and(|text| text.contains("No tool mutates"))
        );
    }

    #[test]
    fn the_tool_list_is_exactly_the_read_only_pair() {
        let reply = call(r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#);
        let tools = reply["result"]["tools"].as_array().expect("array");
        let names: Vec<_> = tools
            .iter()
            .filter_map(|tool| tool["name"].as_str())
            .collect();
        assert_eq!(names, vec!["zenith_list_actions", "zenith_diagnose"]);
        for tool in tools {
            let props = &tool["inputSchema"]["properties"];
            assert!(
                props.as_object().is_some_and(|map| map.is_empty()),
                "a tool grew an argument"
            );
        }
    }

    #[test]
    fn a_tool_result_is_text_content_not_a_bare_object() {
        let reply = call(
            r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"zenith_list_actions","arguments":{}}}"#,
        );
        assert_eq!(reply["result"]["isError"], false);
        let text = reply["result"]["content"][0]["text"]
            .as_str()
            .expect("text");
        assert!(text.contains("flush-dns"));
    }

    #[test]
    fn an_unknown_method_and_an_unknown_tool_are_different_errors() {
        let method = call(r#"{"jsonrpc":"2.0","id":4,"method":"resources/list"}"#);
        assert_eq!(method["error"]["code"], METHOD_NOT_FOUND);
        let tool = call(
            r#"{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"zenith_repair_everything"}}"#,
        );
        assert_eq!(tool["error"]["code"], INVALID_PARAMS);
    }

    #[test]
    fn malformed_json_and_a_missing_method_are_refused_with_the_documented_codes() {
        let parse = call("{not json");
        assert_eq!(parse["error"]["code"], PARSE_ERROR);
        let missing = call(r#"{"jsonrpc":"2.0","id":6}"#);
        assert_eq!(missing["error"]["code"], INVALID_REQUEST);
        let wrong_version = call(r#"{"jsonrpc":"1.0","id":7,"method":"ping"}"#);
        assert_eq!(wrong_version["error"]["code"], INVALID_REQUEST);
    }

    #[test]
    fn a_notification_gets_no_reply() {
        assert_eq!(
            handle_line(
                r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
                &Host
            ),
            None
        );
        assert_eq!(handle_line("   ", &Host), None);
    }

    #[test]
    fn a_stream_of_frames_round_trips_through_the_stdio_loop() {
        let input = concat!(
            "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\"}\n",
            "\n",
            "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"ping\"}\n",
            "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n",
        );
        let mut reader = std::io::Cursor::new(input.as_bytes());
        let mut output = Vec::new();
        let served = serve_stdio(&Host, &mut reader, &mut output).expect("serve");
        assert_eq!(served, 2);
        let lines: Vec<_> = String::from_utf8(output)
            .expect("utf8")
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).expect("json"))
            .collect();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[1]["id"], 2);
    }

    #[test]
    fn a_probe_failure_is_reported_inside_the_result_not_as_a_transport_error() {
        struct Failing;
        impl ToolHost for Failing {
            fn list_actions(&self) -> Vec<ToolAction> {
                Vec::new()
            }
            fn diagnose(&self) -> Result<Value, String> {
                Err("PROBE_UNAVAILABLE".to_string())
            }
        }
        let reply = handle_line(
            r#"{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"zenith_diagnose"}}"#,
            &Failing,
        )
        .expect("reply");
        let value: Value = serde_json::from_str(&reply).expect("json");
        assert_eq!(value["result"]["isError"], true);
        assert!(
            value["result"]["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("PROBE_UNAVAILABLE")
        );
    }
}
