/* CityWalker — configuration du site.
 *
 * apiUrl : adresse du serveur de synchronisation (un Cloudflare Worker, voir
 *   server/ et SYNCHRONISATION.md). Vide, l'application fonctionne entièrement
 *   en local. Sur le site publié, le workflow de déploiement la renseigne
 *   tout seul après avoir mis le serveur en ligne : rien à écrire ici.
 *
 * cartoKey : clé du fond de carte détaillé (tuiles CARTO).
 */
window.CW_CONFIG = {
  apiUrl: '',
  cartoKey: 'cb1_2si0_1_9784af0a74c9f91479d9d44b',
};
