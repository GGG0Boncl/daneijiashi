package com.family.checkin;

import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.InetSocketAddress;

/**
 * 局域网中枢发现：WebView 里的 JS 发不了 UDP 广播，所以这一段用原生做。
 *
 * 协议（和 hub/hub.mjs 对应）：
 *   手机 → 255.255.255.255:8788   "FAMILY-CHECKIN/DISCOVER"
 *   中枢 → 定向回复                {"service":"family-checkin-hub","httpPort":8787,...}
 *   中枢 → 每 5 秒广播一次          "FAMILY-CHECKIN/HERE {同上}"
 *
 * 为什么要监听广播：手机开着热点、或家里路由器挡了广播时，手机自己喊不一定传得到电脑，
 * 但只要中枢在喊、手机在听，照样能自动找到。所以这里先绑 8788（可复用端口）再一边喊一边听，
 * 谁的包先到就用谁。
 */
@CapacitorPlugin(name = "LanDiscovery")
public class LanDiscoveryPlugin extends Plugin {

    private static final String TAG = "LanDiscovery";
    private static final int DEFAULT_UDP_PORT = 8788;
    private static final String PROBE = "FAMILY-CHECKIN/DISCOVER";

    @PluginMethod
    public void discover(PluginCall call) {
        final int udpPort = call.getInt("udpPort", DEFAULT_UDP_PORT);
        final int timeoutMs = call.getInt("timeoutMs", 2500);

        new Thread(() -> {
            DatagramSocket socket = null;
            try {
                socket = openSocket(udpPort);
                socket.setBroadcast(true);
                socket.setSoTimeout(400);

                byte[] probe = PROBE.getBytes("UTF-8");
                InetAddress broadcast = InetAddress.getByName("255.255.255.255");
                socket.send(new DatagramPacket(probe, probe.length, broadcast, udpPort));

                final long deadline = System.currentTimeMillis() + timeoutMs;
                byte[] buf = new byte[2048];

                while (System.currentTimeMillis() < deadline) {
                    DatagramPacket packet = new DatagramPacket(buf, buf.length);
                    try {
                        socket.receive(packet);
                    } catch (java.net.SocketTimeoutException slice) {
                        continue; // 一个切片没收到就接着等，整体不超过 deadline
                    }

                    String text = new String(packet.getData(), 0, packet.getLength(), "UTF-8").trim();
                    int brace = text.indexOf('{');
                    if (brace < 0) continue;

                    JSONObject json;
                    try {
                        json = new JSONObject(text.substring(brace));
                    } catch (Exception badJson) {
                        continue;
                    }
                    if (!"family-checkin-hub".equals(json.optString("service"))) continue;

                    boolean viaAnnounce = text.startsWith("FAMILY-CHECKIN/HERE");
                    Log.i(TAG, "hub found via " + (viaAnnounce ? "announce" : "reply")
                            + " from " + packet.getAddress().getHostAddress() + ": " + text);

                    JSObject out = new JSObject();
                    out.put("ok", true);
                    out.put("ip", packet.getAddress().getHostAddress());
                    out.put("httpPort", json.optInt("httpPort", 8787));
                    out.put("host", json.optString("host", ""));
                    out.put("serverTime", json.optString("serverTime", ""));
                    out.put("via", viaAnnounce ? "announce" : "reply");
                    call.resolve(out);
                    return;
                }

                JSObject out = new JSObject();
                out.put("ok", false);
                out.put("error", "timeout");
                call.resolve(out);
            } catch (Exception e) {
                Log.w(TAG, "discover failed", e);
                call.reject("discover failed: " + e.getMessage(), e);
            } finally {
                if (socket != null) {
                    try {
                        socket.close();
                    } catch (Exception ignored) {
                    }
                }
            }
        }, "lan-discovery").start();
    }

    /**
     * 优先绑在 8788（这样才能收到中枢的广播）；端口被占就退回随机端口，
     * 此时只能靠"我们发问、中枢回答"这条老路，仍然可用。
     */
    private DatagramSocket openSocket(int udpPort) {
        try {
            DatagramSocket bound = new DatagramSocket(null);
            bound.setReuseAddress(true);
            bound.bind(new InetSocketAddress(udpPort));
            return bound;
        } catch (Exception e) {
            Log.i(TAG, "bind " + udpPort + " failed, falling back to ephemeral port: " + e.getMessage());
            try {
                DatagramSocket any = new DatagramSocket();
                any.setReuseAddress(true);
                return any;
            } catch (Exception e2) {
                throw new RuntimeException(e2);
            }
        }
    }
}
