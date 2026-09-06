/* CityWalker — configuration de la synchronisation.
 *
 * Ces deux valeurs viennent de Supabase, Project Settings → API :
 * l'URL du projet et la clé publique « anon ». Cette clé est publique par
 * conception ; ce sont les règles RLS de la base qui protègent les données.
 * Ne colle jamais la clé `service_role` ici.
 *
 * Trois façons de les fournir, de la plus durable à la plus rapide :
 *  1. deux variables de dépôt GitHub, SUPABASE_URL et SUPABASE_ANON_KEY : le
 *     workflow de publication réécrit ce fichier au déploiement (rien à
 *     committer, rien à saisir sur chaque appareil) ;
 *  2. les écrire ici et pousser ;
 *  3. les coller dans Réglages → Compte et synchronisation, sur chaque appareil.
 *
 * Laissé vide, tout fonctionne en local, sans compte.
 */
window.CW_CONFIG = {
  supabaseUrl: '',
  supabaseAnonKey: '',
  // Clé CARTO des fonds raster. Comme la clé anon, elle est publique par
  // conception : elle voyage dans l'URL de chaque tuile.
  cartoKey: 'cb1_2si0_1_9784af0a74c9f91479d9d44b',
};
