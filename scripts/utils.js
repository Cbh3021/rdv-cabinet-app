/* =======================================================================
   UTILITAIRES PARTAGÉS — scripts/
   -----------------------------------------------------------------------
   Ce dépôt est PUBLIC sur GitHub : les logs des workflows planifiés
   (Actions > nom du workflow > détail du run) sont visibles par
   n'importe qui, avec l'horodatage exact de chaque exécution.

   Ne jamais logger un numéro de téléphone patient en clair dans ces
   scripts — utiliser maskPhone() systématiquement. Le code d'accès à
   6 chiffres (lastCode) ne doit lui-même JAMAIS être loggé, masqué ou
   non.
   ======================================================================= */

/**
 * Masque un numéro de téléphone pour les logs, en ne gardant que
 * l'indicatif et les 2 derniers chiffres (suffisant pour déboguer sans
 * identifier le patient).
 * Ex : "+21622123456" -> "+216••••••56"
 */
function maskPhone(phone) {
  if (!phone || typeof phone !== "string" || phone.length < 6) return "••••";
  const head = phone.slice(0, 4);
  const tail = phone.slice(-2);
  const maskedLength = Math.max(phone.length - head.length - tail.length, 3);
  return head + "•".repeat(maskedLength) + tail;
}

module.exports = { maskPhone };
