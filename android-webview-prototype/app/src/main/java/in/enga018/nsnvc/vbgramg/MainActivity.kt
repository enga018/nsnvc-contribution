package in.enga018.nsnvc.vbgramg

import android.app.Activity
import android.app.AlertDialog
import android.graphics.Color
import android.os.Bundle
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener

class MainActivity : Activity() {
    private lateinit var webView: WebView
    private lateinit var status: TextView
    private lateinit var importButton: Button

    private val reportUrl = "https://vbgramgrep.dord.gov.in/VBGRAMG/writereaddata/citizen_out/panchregpeople_2207001005_eng2627.html"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.rgb(247, 246, 242))
        }
        root.addView(TextView(this).apply {
            text = "NSNVC · Official report"
            textSize = 19f
            setTextColor(Color.WHITE)
            setBackgroundColor(Color.rgb(27, 77, 62))
            setPadding(dp(16), dp(15), dp(16), dp(15))
        }, LinearLayout.LayoutParams(-1, -2))
        status = TextView(this).apply {
            text = "Opening the official VB-GRAMG report…"
            textSize = 13f
            setTextColor(Color.rgb(28, 39, 36))
            setPadding(dp(12), dp(8), dp(12), dp(8))
        }
        root.addView(status, LinearLayout.LayoutParams(-1, -2))
        val actions = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(dp(8), dp(4), dp(8), dp(8))
        }
        val reload = Button(this).apply {
            text = "Reload report"
            setOnClickListener { webView.loadUrl(reportUrl) }
        }
        importButton = Button(this).apply {
            text = "Import / Preview"
            isEnabled = false
            setOnClickListener { extractReportTable() }
        }
        actions.addView(reload, LinearLayout.LayoutParams(0, -2, 1f))
        actions.addView(importButton, LinearLayout.LayoutParams(0, -2, 1f))
        root.addView(actions, LinearLayout.LayoutParams(-1, -2))

        webView = WebView(this)
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
            safeBrowsingEnabled = true
        }
        webView.webChromeClient = WebChromeClient()
        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                !isAllowedReportHost(request.url.host)

            override fun onPageFinished(view: WebView, url: String) {
                if (isAllowedReportHost(android.net.Uri.parse(url).host)) {
                    status.text = "Page loaded. Tap Import / Preview to inspect its table. Nothing is saved to the tracker."
                    importButton.isEnabled = true
                } else {
                    status.text = "Blocked unexpected page host. Return to the official report."
                    importButton.isEnabled = false
                }
            }
        }
        root.addView(webView, LinearLayout.LayoutParams(-1, 0, 1f))
        setContentView(root)
        if (savedInstanceState != null) webView.restoreState(savedInstanceState) else webView.loadUrl(reportUrl)
    }

    private fun isAllowedReportHost(host: String?): Boolean {
        if (host == null) return false
        return host.equals("vbgramgrep.dord.gov.in", true) || host.endsWith(".dord.gov.in", true)
    }

    private fun extractReportTable() {
        if (!isAllowedReportHost(android.net.Uri.parse(webView.url ?: "").host)) {
            status.text = "Import blocked: current page is not on the approved government domain."
            return
        }
        importButton.isEnabled = false
        status.text = "Inspecting page tables…"
        val script = """
            (function() {
              const tables = Array.from(document.querySelectorAll('table'));
              const table = tables.sort((a, b) => b.querySelectorAll('tr').length - a.querySelectorAll('tr').length)[0];
              if (!table) return JSON.stringify({title:document.title||'',url:location.href,error:'No HTML table found',tableCount:tables.length,rows:[]});
              const rows = Array.from(table.querySelectorAll('tr')).map(tr =>
                Array.from(tr.querySelectorAll('th,td')).map(cell =>
                  (cell.innerText || cell.textContent || '').replace(/\s+/g, ' ').trim()
                )
              );
              return JSON.stringify({title:document.title||'',url:location.href,tableCount:tables.length,rows:rows});
            })();
        """.trimIndent()
        webView.evaluateJavascript(script) { raw ->
            importButton.isEnabled = true
            try {
                val decoded = JSONTokener(raw).nextValue() as? String
                    ?: throw IllegalStateException("The page returned an unreadable result.")
                val result = JSONObject(decoded)
                if (!isAllowedReportHost(android.net.Uri.parse(result.optString("url")).host)) {
                    throw SecurityException("Extracted result did not come from the approved government host.")
                }
                val rows = result.optJSONArray("rows") ?: JSONArray()
                status.text = if (rows.length() == 0) "No table rows found. The page may be an error or session page."
                    else "Read ${rows.length()} table rows. Preview only; no tracker data changed."
                showPreview(result, rows)
            } catch (error: Exception) {
                status.text = "Could not inspect report: ${error.message}"
            }
        }
    }

    private fun showPreview(result: JSONObject, rows: JSONArray) {
        val text = StringBuilder()
            .append("Page: ").append(result.optString("title", "(untitled)"))
            .append("\nTables found: ").append(result.optInt("tableCount"))
            .append("\nRaw table rows: ").append(rows.length())
            .append("\n\nFirst rows (read-only preview):\n")
        val maxRows = minOf(rows.length(), 12)
        for (i in 0 until maxRows) {
            val row = rows.optJSONArray(i) ?: JSONArray()
            val cells = (0 until row.length()).map { row.optString(it) }
            text.append("\nRow ").append(i + 1).append(": ").append(cells.joinToString(" | ").take(600))
        }
        if (rows.length() > maxRows) text.append("\n\n…and ").append(rows.length() - maxRows).append(" more rows.")
        text.append("\n\nThis prototype only previews page text. It does not write to Firestore or the contribution ledger.")
        val body = TextView(this).apply {
            this.text = text.toString()
            textSize = 13f
            setTextColor(Color.rgb(28, 39, 36))
            setPadding(dp(16), dp(12), dp(16), dp(12))
        }
        AlertDialog.Builder(this)
            .setTitle("Registration table preview")
            .setView(ScrollView(this).apply { addView(body) })
            .setPositiveButton("Close", null)
            .show()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        webView.saveState(outState)
        super.onSaveInstanceState(outState)
    }

    @Deprecated("Deprecated in Android API 33; retained for older Android compatibility")
    override fun onBackPressed() {
        if (::webView.isInitialized && webView.canGoBack()) webView.goBack() else super.onBackPressed()
    }

    override fun onDestroy() {
        if (::webView.isInitialized) {
            webView.stopLoading()
            webView.webChromeClient = null
            webView.destroy()
        }
        super.onDestroy()
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()
}
