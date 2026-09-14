package com.belhoula.rdvcabinet;

import android.os.Bundle;
import android.view.View;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Désactive le remplissage automatique natif d'Android sur la
        // WebView : sinon Android propose tout l'historique des noms
        // déjà tapés dans un champ (ex: "Nom du patient"), sans filtrer
        // selon ce qu'on tape — ça cachait la moitié de l'écran et
        // n'avait rien à voir avec notre liste de suggestions maison.
        WebView webView = getBridge().getWebView();
        if (webView != null) {
            webView.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO);
        }
    }
}
