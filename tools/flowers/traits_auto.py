"""Step 2b of the flower data: an automatic likeness for every chosen species.

    python tools/flowers/traits_auto.py          # write traits.auto.json
    python tools/flowers/traits_auto.py --sheet  # also write the review sheet

build.py chooses species round robin across the cells. This script decides,
for each one, whether it's a forest-floor wildflower at all and, if so, its
look: petal and centre colour, head shape and height. It writes
traits.auto.json; build.py merges it under traits.json, so a hand-written
entry in traits.json (a list, or "skip") always wins.

- Family and genus come from iNaturalist's taxa (the ancestors of each
  species), cached in cache/taxa.json.
- Skip: grasses, sedges and rushes, woody families (trees and shrubs), cacti,
  water plants, and plants whose flowers don't show. Skipped species are
  replaced by the next in the round robin, until 300 are kept.
- Shape and height: tables by family, with genus exceptions.
- Colour: measured from the species' default iNaturalist photo, a 75 px
  thumbnail that is only read here and never stored or shipped (photo
  licences vary, so only one derived colour per species is kept). Green,
  brown and dark pixels are ignored; the petal is the main remaining colour
  round the middle of the photo, the centre the main colour at the very
  middle if it's clearly different.

The review sheet (tools/flowers/sheet.html, opened from a local server at
the repo root) draws every kept species' flower tile with its name, so odd
likenesses can be fixed in traits.json.
"""
import colorsys
import io
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build import CACHE, TRAITS, TOTAL, load_cells, round_robin  # noqa: E402

HERE = Path(__file__).resolve().parent
AUTO = HERE / 'traits.auto.json'
TAXA = CACHE / 'taxa.json'
PHOTOS = CACHE / 'photos.json'  # derived colours per photo URL (not the photos)
SHEET = HERE / 'sheet.json'
API = 'https://api.inaturalist.org/v1/taxa/'
UA = 'playtreeone-flower-build (https://github.com/TechyBen/playtreeone)'

# --------------------------------------------------------------- skip rules
SKIP_FAMILIES = {
    # grasses, sedges, rushes, reeds
    'Poaceae', 'Cyperaceae', 'Juncaceae', 'Typhaceae', 'Restionaceae', 'Xanthorrhoeaceae',
    # trees and shrubs
    'Fagaceae', 'Betulaceae', 'Salicaceae', 'Sapindaceae', 'Oleaceae', 'Myrtaceae', 'Proteaceae',
    'Rhizophoraceae', 'Combretaceae', 'Juglandaceae', 'Ulmaceae', 'Moraceae', 'Anacardiaceae',
    'Meliaceae', 'Lauraceae', 'Magnoliaceae', 'Arecaceae', 'Platanaceae', 'Hamamelidaceae',
    'Aquifoliaceae', 'Cornaceae', 'Adoxaceae', 'Viburnaceae', 'Elaeagnaceae', 'Tamaricaceae',
    'Rhamnaceae', 'Celastraceae', 'Altingiaceae', 'Nothofagaceae', 'Casuarinaceae',
    'Dipterocarpaceae', 'Grossulariaceae', 'Berberidaceae', 'Hydrangeaceae', 'Thymelaeaceae',
    'Pittosporaceae', 'Ebenaceae', 'Sapotaceae', 'Annonaceae', 'Myristicaceae', 'Burseraceae',
    'Simaroubaceae', 'Calophyllaceae', 'Clusiaceae', 'Chrysobalanaceae', 'Lecythidaceae',
    'Vochysiaceae', 'Ochnaceae', 'Salvadoraceae', 'Simmondsiaceae', 'Buxaceae', 'Eucommiaceae',
    'Garryaceae', 'Styracaceae', 'Symplocaceae', 'Theaceae', 'Pentaphylacaceae', 'Escalloniaceae',
    'Atherospermataceae', 'Monimiaceae', 'Winteraceae', 'Cunoniaceae', 'Elaeocarpaceae',
    'Rutaceae', 'Vitaceae', 'Schisandraceae', 'Paulowniaceae', 'Muntingiaceae', 'Putranjivaceae',
    'Phyllanthaceae', 'Loranthaceae', 'Viscaceae', 'Santalaceae', 'Calycanthaceae', 'Cannabaceae', 'Ixonanthaceae', 'Picramniaceae',
    'Myricaceae', 'Coriariaceae', 'Lardizabalaceae', 'Bixaceae', 'Dilleniaceae', 'Ixerbaceae',
    # cacti and succulents that read as cacti
    'Cactaceae', 'Didiereaceae',
    # water plants
    'Nymphaeaceae', 'Nelumbonaceae', 'Pontederiaceae', 'Hydrocharitaceae', 'Potamogetonaceae',
    'Alismataceae', 'Cabombaceae', 'Haloragaceae',
    'Ceratophyllaceae', 'Hydatellaceae', 'Lemnaceae', 'Zosteraceae', 'Cymodoceaceae',
    'Posidoniaceae', 'Ruppiaceae', 'Aponogetonaceae', 'Podostemaceae',
    # flowers that don't show, or epiphytes
    'Urticaceae', 'Amaranthaceae', 'Bromeliaceae', 'Piperaceae', 'Cytinaceae', 'Rafflesiaceae',
    'Cucurbitaceae', 'Dioscoreaceae', 'Smilacaceae', 'Cannabaceae', 'Aristolochiaceae',
}
SKIP_GENERA = {
    # trees and shrubs in otherwise herby families
    'Prunus', 'Crataegus', 'Malus', 'Pyrus', 'Sorbus', 'Amelanchier', 'Cotoneaster', 'Pyracantha',
    'Photinia', 'Heteromeles', 'Cercocarpus', 'Purshia', 'Adenostoma', 'Spiraea', 'Physocarpus',
    'Holodiscus', 'Chaenomeles', 'Eriobotrya', 'Rhaphiolepis', 'Prinsepia', 'Exochorda',
    'Acacia', 'Vachellia', 'Senegalia', 'Robinia', 'Cercis', 'Prosopis', 'Albizia', 'Bauhinia',
    'Erythrina', 'Ulex', 'Cytisus', 'Genista', 'Spartium', 'Laburnum', 'Wisteria', 'Gleditsia',
    'Caesalpinia', 'Delonix', 'Cassia', 'Senna', 'Mimosa', 'Leucaena', 'Parkinsonia', 'Inga',
    'Pterocarpus', 'Dalbergia', 'Tamarindus', 'Amorpha', 'Sophora', 'Pithecellobium', 'Calliandra',
    'Psorothamnus', 'Olneya', 'Parkia', 'Hymenaea', 'Peltophorum', 'Pongamia', 'Millettia',
    'Rhododendron', 'Arbutus', 'Arctostaphylos', 'Kalmia', 'Vaccinium', 'Gaultheria', 'Pieris',
    'Leucothoe', 'Lyonia', 'Oxydendrum', 'Comarostaphylis', 'Epacris', 'Leucopogon', 'Agarista',
    'Baccharis', 'Brachyglottis', 'Olearia', 'Artemisia', 'Ambrosia', 'Xanthium',
    'Tilia', 'Ceiba', 'Brachychiton', 'Theobroma', 'Sterculia', 'Adansonia', 'Bombax', 'Grewia',
    'Jacaranda', 'Catalpa', 'Tabebuia', 'Handroanthus', 'Spathodea', 'Kigelia', 'Tecoma',
    'Lonicera', 'Symphoricarpos', 'Sambucus', 'Viburnum', 'Weigela', 'Abelia', 'Ricinus', 'Croton', 'Jatropha', 'Hevea', 'Mallotus', 'Macaranga', 'Alchornea', 'Duranta', 'Vitex', 'Callicarpa', 'Tectona', 'Clerodendrum', 'Premna',
    'Buddleja', 'Myoporum', 'Eremophila', 'Leptospermum', 'Coffea', 'Psychotria', 'Gardenia',
    'Ixora', 'Cephalanthus', 'Hamelia', 'Rosmarinus', 'Nerium', 'Plumeria', 'Thevetia',
    'Cascabela', 'Alstonia', 'Calotropis', 'Allamanda', 'Carissa', 'Tabernaemontana',
    'Yucca', 'Agave', 'Dracaena', 'Cordyline', 'Hesperoyucca', 'Dasylirion', 'Nolina',
    'Rumex', 'Plantago', 'Chenopodium', 'Cuscuta', 'Coccoloba', 'Muehlenbeckia',
    'Fallopia', 'Reynoutria', 'Calligonum', 'Ceanothus', 'Mahonia', 'Berberis', 'Ribes',
    'Philadelphus', 'Deutzia', 'Hydrangea', 'Miconia',
    'Clidemia', 'Tibouchina', 'Pleroma', 'Larrea', 'Fouquieria', 'Eriodictyon', 'Phlomis', 'Halimium', 'Lycium', 'Brugmansia', 'Cestrum',
}

# --------------------------------------------------------------- shapes
FAMILY_SHAPE = {
    'Asteraceae': 'daisy', 'Aizoaceae': 'daisy', 'Calyceraceae': 'cluster',
    'Apiaceae': 'umbel', 'Araliaceae': 'umbel',
    'Lamiaceae': 'spike', 'Plantaginaceae': 'spike', 'Orchidaceae': 'spike', 'Lythraceae': 'spike',
    'Verbenaceae': 'spike', 'Orobanchaceae': 'spike', 'Scrophulariaceae': 'spike', 'Resedaceae': 'spike',
    'Haemodoraceae': 'spike', 'Asphodelaceae': 'spike', 'Zingiberaceae': 'spike', 'Heliconiaceae': 'spike',
    'Costaceae': 'spike', 'Marantaceae': 'spike', 'Cannaceae': 'trumpet', 'Acanthaceae': 'trumpet',
    'Campanulaceae': 'bell', 'Ericaceae': 'bell', 'Asparagaceae': 'bell', 'Melanthiaceae': 'star',
    'Ranunculaceae': 'cup', 'Rosaceae': 'cup', 'Geraniaceae': 'cup', 'Papaveraceae': 'cup',
    'Malvaceae': 'cup', 'Violaceae': 'cup', 'Onagraceae': 'cup', 'Cistaceae': 'cup', 'Paeoniaceae': 'cup',
    'Hypericaceae': 'cup', 'Linaceae': 'cup', 'Montiaceae': 'star', 'Portulacaceae': 'cup',
    'Commelinaceae': 'cup', 'Begoniaceae': 'cup', 'Melastomataceae': 'cup', 'Passifloraceae': 'cup',
    'Zygophyllaceae': 'cup', 'Loasaceae': 'cup', 'Limnanthaceae': 'cup', 'Turneraceae': 'cup',
    'Caryophyllaceae': 'star', 'Brassicaceae': 'star', 'Boraginaceae': 'star', 'Solanaceae': 'star',
    'Primulaceae': 'star', 'Oxalidaceae': 'star', 'Polemoniaceae': 'star', 'Hydrophyllaceae': 'star',
    'Apocynaceae': 'star', 'Saxifragaceae': 'star', 'Crassulaceae': 'star', 'Hypoxidaceae': 'star',
    'Goodeniaceae': 'star', 'Stylidiaceae': 'star', 'Droseraceae': 'star', 'Tecophilaeaceae': 'star',
    'Rubiaceae': 'cluster', 'Fabaceae': 'cluster', 'Polygonaceae': 'cluster', 'Euphorbiaceae': 'cluster',
    'Caprifoliaceae': 'cluster', 'Dipsacaceae': 'cluster', 'Plumbaginaceae': 'cluster',
    'Polygalaceae': 'cluster', 'Nyctaginaceae': 'trumpet', 'Valerianaceae': 'umbel',
    'Convolvulaceae': 'trumpet', 'Liliaceae': 'trumpet', 'Amaryllidaceae': 'trumpet', 'Iridaceae': 'trumpet',
    'Gentianaceae': 'trumpet', 'Bignoniaceae': 'trumpet', 'Gesneriaceae': 'trumpet', 'Colchicaceae': 'trumpet',
    'Lentibulariaceae': 'trumpet', 'Tropaeolaceae': 'trumpet', 'Balsaminaceae': 'trumpet',
    'Martyniaceae': 'trumpet', 'Pedaliaceae': 'trumpet', 'Alstroemeriaceae': 'trumpet', 'Araceae': 'trumpet',
    'Menyanthaceae': 'star', 'Phrymaceae': 'trumpet', 'Linderniaceae': 'trumpet', 'Mazaceae': 'trumpet',
    'Cleomaceae': 'cluster', 'Capparaceae': 'cluster', 'Fumariaceae': 'spike',
}
GENUS_SHAPE = {
    'Cirsium': 'cluster', 'Carduus': 'cluster', 'Centaurea': 'cluster', 'Arctium': 'cluster',
    'Trifolium': 'cluster', 'Onopordum': 'cluster', 'Silybum': 'cluster', 'Echinops': 'cluster',
    'Eupatorium': 'cluster', 'Ageratina': 'cluster', 'Solidago': 'spike', 'Liatris': 'spike',
    'Achillea': 'umbel', 'Tanacetum': 'cluster', 'Gnaphalium': 'cluster', 'Pseudognaphalium': 'cluster',
    'Allium': 'umbel', 'Asclepias': 'umbel', 'Sambucus': 'umbel', 'Valeriana': 'umbel', 'Centranthus': 'umbel',
    'Lupinus': 'spike', 'Melilotus': 'spike', 'Vicia': 'spike', 'Astragalus': 'spike', 'Medicago': 'cluster',
    'Persicaria': 'spike', 'Polygonum': 'spike', 'Bistorta': 'spike', 'Eriogonum': 'cluster',
    'Hyacinthoides': 'bell', 'Convallaria': 'bell', 'Muscari': 'spike', 'Camassia': 'spike',
    'Ornithogalum': 'star', 'Brodiaea': 'umbel', 'Dichelostemma': 'umbel', 'Triteleia': 'umbel',
    'Chlorogalum': 'star', 'Maianthemum': 'spike', 'Polygonatum': 'bell', 'Scilla': 'star',
    'Galanthus': 'bell', 'Leucojum': 'bell', 'Narcissus': 'trumpet', 'Erythronium': 'bell',
    'Fritillaria': 'bell', 'Tulipa': 'cup', 'Calochortus': 'cup', 'Sisyrinchium': 'star',
    'Crocus': 'cup', 'Moraea': 'cup', 'Gladiolus': 'spike', 'Watsonia': 'spike', 'Crocosmia': 'spike',
    'Delphinium': 'spike', 'Aconitum': 'spike', 'Consolida': 'spike', 'Actaea': 'spike',
    'Aquilegia': 'bell', 'Clematis': 'star', 'Anemone': 'cup', 'Thalictrum': 'cluster',
    'Digitalis': 'spike', 'Veronica': 'spike', 'Linaria': 'spike', 'Penstemon': 'spike',
    'Antirrhinum': 'spike', 'Verbascum': 'spike', 'Castilleja': 'spike', 'Pedicularis': 'spike',
    'Verbena': 'spike', 'Glandularia': 'cluster', 'Lantana': 'cluster', 'Phyla': 'cluster',
    'Mentha': 'spike', 'Thymus': 'cluster', 'Origanum': 'cluster', 'Monarda': 'cluster',
    'Prunella': 'spike', 'Ajuga': 'spike', 'Glechoma': 'trumpet', 'Lamium': 'cluster',
    'Galium': 'cluster', 'Cruciata': 'cluster', 'Houstonia': 'star', 'Richardia': 'cluster',
    'Myosotis': 'star', 'Echium': 'spike', 'Symphytum': 'bell', 'Mertensia': 'bell',
    'Pulmonaria': 'bell', 'Borago': 'star', 'Heliotropium': 'cluster', 'Phacelia': 'cluster',
    'Cerastium': 'star', 'Stellaria': 'star', 'Dianthus': 'star', 'Silene': 'star',
    'Calystegia': 'trumpet', 'Ipomoea': 'trumpet', 'Convolvulus': 'trumpet',
    'Epilobium': 'spike', 'Chamaenerion': 'spike', 'Chamerion': 'spike', 'Oenothera': 'cup',
    'Lythrum': 'spike', 'Cuphea': 'trumpet', 'Impatiens': 'trumpet',
    'Corydalis': 'spike', 'Fumaria': 'spike', 'Dicentra': 'bell', 'Eschscholzia': 'cup',
    'Erica': 'bell', 'Calluna': 'bell', 'Vinca': 'star', 'Catharanthus': 'star',
    'Primula': 'star', 'Lysimachia': 'star', 'Anagallis': 'star', 'Cyclamen': 'trumpet',
    'Dodecatheon': 'trumpet', 'Trientalis': 'star', 'Pinguicula': 'trumpet', 'Utricularia': 'trumpet',
    'Sedum': 'star', 'Saxifraga': 'star', 'Tiarella': 'spike', 'Heuchera': 'bell',
    'Lobelia': 'spike', 'Campanula': 'bell', 'Jasione': 'cluster', 'Phyteuma': 'cluster',
    'Kniphofia': 'spike', 'Aloe': 'spike', 'Bulbine': 'star', 'Asphodelus': 'star',
    'Hemerocallis': 'trumpet', 'Trillium': 'cup', 'Zigadenus': 'cluster', 'Toxicoscordion': 'cluster',
    'Veratrum': 'spike', 'Paris': 'star', 'Geum': 'cup', 'Potentilla': 'cup', 'Fragaria': 'cup',
    'Filipendula': 'cluster', 'Sanguisorba': 'cluster', 'Agrimonia': 'spike', 'Alchemilla': 'cluster',
    'Dipsacus': 'cluster', 'Knautia': 'cluster', 'Scabiosa': 'cluster', 'Succisa': 'cluster',
    'Armeria': 'cluster', 'Limonium': 'cluster', 'Plumbago': 'star',
}

# --------------------------------------------------------------- heights (m)
FAMILY_HEIGHT = {
    'Asteraceae': 0.4, 'Apiaceae': 0.9, 'Orchidaceae': 0.3, 'Lamiaceae': 0.4, 'Fabaceae': 0.35,
    'Brassicaceae': 0.4, 'Caryophyllaceae': 0.35, 'Ranunculaceae': 0.4, 'Rosaceae': 0.3,
    'Campanulaceae': 0.4, 'Ericaceae': 0.3, 'Boraginaceae': 0.4, 'Onagraceae': 0.6, 'Malvaceae': 0.8,
    'Papaveraceae': 0.5, 'Liliaceae': 0.5, 'Amaryllidaceae': 0.4, 'Iridaceae': 0.5, 'Violaceae': 0.15,
    'Primulaceae': 0.2, 'Oxalidaceae': 0.15, 'Geraniaceae': 0.35, 'Convolvulaceae': 0.5,
    'Plantaginaceae': 0.4, 'Orobanchaceae': 0.35, 'Asparagaceae': 0.35, 'Montiaceae': 0.15,
    'Crassulaceae': 0.15, 'Saxifragaceae': 0.25, 'Rubiaceae': 0.3, 'Gentianaceae': 0.3,
    'Solanaceae': 0.5, 'Polemoniaceae': 0.4, 'Hydrophyllaceae': 0.4, 'Apocynaceae': 0.6,
    'Zingiberaceae': 1.2, 'Heliconiaceae': 1.6, 'Costaceae': 1.4, 'Cannaceae': 1.2, 'Acanthaceae': 0.6,
    'Melanthiaceae': 0.35, 'Aizoaceae': 0.15, 'Commelinaceae': 0.3, 'Polygonaceae': 0.5,
    'Euphorbiaceae': 0.35, 'Lythraceae': 0.9, 'Asphodelaceae': 0.7, 'Scrophulariaceae': 0.9,
    'Balsaminaceae': 0.8, 'Gesneriaceae': 0.25, 'Begoniaceae': 0.3, 'Hypericaceae': 0.5,
}
GENUS_HEIGHT = {
    'Digitalis': 1.2, 'Verbascum': 1.4, 'Epilobium': 0.9, 'Chamaenerion': 1.2, 'Chamerion': 1.2,
    'Helianthus': 1.5, 'Solidago': 0.9, 'Eupatorium': 1.2, 'Eutrochium': 1.4, 'Heracleum': 1.6,
    'Lupinus': 0.8, 'Taraxacum': 0.2, 'Bellis': 0.1, 'Trifolium': 0.2, 'Viola': 0.15, 'Ranunculus': 0.4,
    'Ficaria': 0.15, 'Hyacinthoides': 0.35, 'Galanthus': 0.15, 'Crocus': 0.1, 'Iris': 0.6, 'Lilium': 1.0,
    'Rosa': 1.2, 'Rubus': 1.0, 'Geranium': 0.4, 'Cirsium': 1.0, 'Carduus': 1.0, 'Arctium': 1.2,
    'Centaurea': 0.6, 'Achillea': 0.5, 'Leucanthemum': 0.6, 'Erigeron': 0.4, 'Symphyotrichum': 0.8,
    'Rudbeckia': 0.7, 'Echinacea': 0.8, 'Anemone': 0.2, 'Anemonoides': 0.2, 'Primula': 0.2,
    'Potentilla': 0.2, 'Fragaria': 0.15, 'Lotus': 0.2, 'Medicago': 0.3, 'Vicia': 0.5, 'Lathyrus': 0.6,
    'Melilotus': 1.0, 'Impatiens': 0.9, 'Lythrum': 1.0, 'Oenothera': 0.8, 'Ipomoea': 0.6,
    'Asclepias': 0.8, 'Delphinium': 1.0, 'Aconitum': 1.0, 'Aquilegia': 0.5, 'Papaver': 0.5,
    'Hypochaeris': 0.3, 'Sonchus': 0.7, 'Lactuca': 0.9, 'Bidens': 0.6, 'Tithonia': 1.5,
    'Ageratina': 0.8, 'Senecio': 0.5, 'Jacobaea': 0.7, 'Tussilago': 0.15, 'Pilosella': 0.2,
    'Hieracium': 0.4, 'Leontodon': 0.3, 'Crepis': 0.4, 'Cichorium': 0.8, 'Tragopogon': 0.6,
    'Mentha': 0.5, 'Prunella': 0.15, 'Glechoma': 0.15, 'Ajuga': 0.15, 'Lamium': 0.25, 'Stachys': 0.6,
    'Galium': 0.3, 'Veronica': 0.2, 'Stellaria': 0.2, 'Cerastium': 0.15, 'Myosotis': 0.25,
    'Oxalis': 0.15, 'Erodium': 0.15, 'Malva': 0.6, 'Sida': 0.5, 'Calochortus': 0.4, 'Tulipa': 0.35,
    'Narcissus': 0.35, 'Allium': 0.5, 'Erythronium': 0.25, 'Trillium': 0.35, 'Gladiolus': 0.8,
    'Kniphofia': 1.0, 'Aloe': 0.8, 'Hemerocallis': 0.8, 'Canna': 1.2, 'Heliconia': 1.6,
    'Calluna': 0.3, 'Erica': 0.4, 'Silene': 0.5, 'Saponaria': 0.5, 'Dianthus': 0.3, 'Lychnis': 0.6,
    'Eschscholzia': 0.3, 'Castilleja': 0.4, 'Penstemon': 0.6, 'Antirrhinum': 0.5, 'Linaria': 0.5,
    'Clematis': 1.2, 'Passiflora': 1.0, 'Cosmos': 0.9, 'Gaillardia': 0.4, 'Coreopsis': 0.5,
    'Encelia': 0.8, 'Eriophyllum': 0.4, 'Wyethia': 0.5, 'Balsamorhiza': 0.5, 'Arnica': 0.4,
    'Sedum': 0.12, 'Saxifraga': 0.15, 'Drosera': 0.1, 'Pinguicula': 0.1, 'Utricularia': 0.15,
}
DEFAULT_HEIGHT = 0.4

# Fallback colours when the photo gives too few flower pixels.
FAMILY_COLOUR = {
    'Asteraceae': ('#f2c21e', '#d49a12'), 'Apiaceae': ('#f2f0e4', '#f2f0e4'),
    'Lamiaceae': ('#9b6cc4', '#9b6cc4'), 'Fabaceae': ('#c86ab8', '#c86ab8'),
    'Brassicaceae': ('#f2e04a', '#f2e04a'), 'Ranunculaceae': ('#f4cf22', '#e0b010'),
    'Rosaceae': ('#f4f1ea', '#e8c23a'), 'Orchidaceae': ('#c86ab8', '#e8d8e8'),
    'Campanulaceae': ('#6d6ccc', '#6d6ccc'), 'Caryophyllaceae': ('#f4f1ea', '#f4f1ea'),
    'Boraginaceae': ('#5d7fd6', '#f0e070'), 'Violaceae': ('#7a5ac8', '#f0e070'),
}
DEFAULT_COLOUR = ('#d86aa0', '#f0d860')


# --------------------------------------------------------------- iNaturalist
def fetch_json(url, pause=1.1):
    for attempt in range(8):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=60) as r:
                data = r.read()
            time.sleep(pause)
            return data
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504):
                time.sleep(15 * (attempt + 1))
                continue
            raise
        except urllib.error.URLError:
            time.sleep(15 * (attempt + 1))
    raise SystemExit(f'gave up on {url}')


def load(path, default):
    return json.loads(path.read_text('utf-8')) if path.exists() else default


def save(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=0), 'utf-8')


def lookup_taxa(ids, taxa):
    """Fill taxa[str(id)] = {name, family, order, genus, photo} for each id."""
    todo = [i for i in ids if str(i) not in taxa]
    for k in range(0, len(todo), 30):
        batch = todo[k:k + 30]
        data = json.loads(fetch_json(API + ','.join(map(str, batch))))
        for r in data.get('results', []):
            ranks = {a['rank']: a['name'] for a in r.get('ancestors', [])}
            if not ranks and r.get('ancestor_ids'):
                ranks = resolve_ancestors(r['ancestor_ids'], taxa)
            photo = r.get('default_photo') or {}
            taxa[str(r['id'])] = {
                'name': r['name'], 'family': ranks.get('family', ''), 'order': ranks.get('order', ''),
                'genus': ranks.get('genus', r['name'].split()[0]), 'photo': photo.get('square_url', ''),
            }
        for i in batch:  # ids iNaturalist didn't return (merged or removed taxa)
            taxa.setdefault(str(i), {'name': '', 'family': '', 'order': '', 'genus': '', 'photo': ''})
        save(TAXA, taxa)
        print(f'  taxa {min(k + 30, len(todo))}/{len(todo)}', flush=True)


def resolve_ancestors(anc_ids, taxa):
    anc = taxa.setdefault('_ancestors', {})
    need = [str(a) for a in anc_ids if str(a) not in anc]
    for k in range(0, len(need), 30):
        data = json.loads(fetch_json(API + ','.join(need[k:k + 30])))
        for r in data.get('results', []):
            anc[str(r['id'])] = [r['rank'], r['name']]
    return {anc[str(a)][0]: anc[str(a)][1] for a in anc_ids if str(a) in anc}


# --------------------------------------------------------------- colour
def hexc(rgb):
    return '#' + ''.join(f'{int(round(max(0, min(1, c)) * 255)):02x}' for c in rgb)


def tame(rgb, white=False):
    """Clamp a measured colour into a pleasant, PS1-friendly range."""
    h, s, v = colorsys.rgb_to_hsv(*rgb)
    if white:
        return colorsys.hsv_to_rgb(h, min(s, 0.1), max(0.88, min(v, 0.96)))
    deg = h * 360
    if 20 <= deg <= 70:
        # Yellows and oranges photograph dark and dull (olive, khaki), so
        # lift them back to how they look in the field.
        return colorsys.hsv_to_rgb(h, max(0.6, min(s * 1.25, 0.9)), max(0.85, min(v * 1.15, 0.97)))
    return colorsys.hsv_to_rgb(h, max(0.3, min(s * 1.1, 0.85)), max(0.6, min(v * 1.1, 0.95)))


def classify(img):
    """Per pixel: 0 ignore, 1 coloured flower-ish, 2 white-ish."""
    a = np.asarray(img, dtype=np.float32) / 255
    mx, mn = a.max(2), a.min(2)
    v, s = mx, np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-6), 0)
    hsv = np.asarray(img.convert('HSV'), dtype=np.float32)
    hue = hsv[..., 0] / 255 * 360
    green = (hue > 55) & (hue < 175) & (s > 0.18)
    brown = (hue > 10) & (hue < 50) & (v < 0.55) & (s > 0.2)
    sky = (hue > 185) & (hue < 225) & (s < 0.55) & (v > 0.6)
    colour = (s >= 0.28) & (v >= 0.3) & ~green & ~brown & ~sky
    white = (s < 0.16) & (v > 0.72)
    cls = np.zeros(v.shape, np.int8)
    cls[colour] = 1
    cls[white] = 2
    return a, hue, s, cls


def dominant(a, hue, s, cls, w):
    """The main colour among the weighted flower pixels: ('white'|'colour', rgb, share)."""
    wc, ww = (w * (cls == 1)).sum(), (w * (cls == 2)).sum()
    if wc + ww <= 0:
        return None
    if ww > wc * 1.3:
        m = w * (cls == 2)
        return 'white', (a * m[..., None]).sum((0, 1)) / m.sum(), ww / (wc + ww)
    bins = (hue // 15).astype(int) % 24
    m = w * (cls == 1) * (0.4 + s)
    hist = np.bincount(bins.ravel(), m.ravel(), 24)
    sm = hist + 0.5 * (np.roll(hist, 1) + np.roll(hist, -1))
    b = int(sm.argmax())
    near = (np.abs(((bins - b + 12) % 24) - 12) <= 1) & (cls == 1)
    mm = w * near
    return 'colour', (a * mm[..., None]).sum((0, 1)) / mm.sum(), wc / (wc + ww)


def photo_colours(url, cache):
    if url in cache:
        return cache[url]
    img = Image.open(io.BytesIO(fetch_json(url, 0.3))).convert('RGB').resize((64, 64))
    a, hue, s, cls = classify(img)
    yy, xx = np.mgrid[0:64, 0:64]
    r = np.hypot(xx - 31.5, yy - 31.5) / 32
    ring = np.exp(-((r - 0.32) / 0.22) ** 2)      # round the middle: petals
    core = (r < 0.17).astype(np.float32)           # the very middle: a disc
    flowerish = ((w := np.exp(-(r / 0.6) ** 2)) * (cls > 0)).sum() / w.sum()
    res = None
    if flowerish > 0.06:
        p = dominant(a, hue, s, cls, ring) or dominant(a, hue, s, cls, w)
        c = dominant(a, hue, s, cls, core)
        if p:
            # Kept as measured ([kind, rgb] for petal and centre); tamed on use.
            res = [[p[0], [round(float(x), 4) for x in p[1]]]]
            if c and c[0] != p[0] or (c and c[0] == 'colour' and hue_gap(c[1], p[1]) > 40):
                res.append([c[0], [round(float(x), 4) for x in c[1]]])
    cache[url] = res
    save(PHOTOS, cache)
    return res


def likeness(measured):
    """Petal and centre hex colours from a photo measurement (or None)."""
    if not measured:
        return None
    petal = hexc(tame(measured[0][1], measured[0][0] == 'white'))
    centre = hexc(tame(measured[-1][1], measured[-1][0] == 'white'))
    return [petal, centre]


def hue_gap(a, b):
    ha, hb = colorsys.rgb_to_hsv(*a)[0] * 360, colorsys.rgb_to_hsv(*b)[0] * 360
    d = abs(ha - hb) % 360
    return min(d, 360 - d)


# --------------------------------------------------------------- decisions
def decide(t):
    fam, gen = t['family'], t['genus']
    if not fam:
        return 'skip', 'no taxonomy'
    if fam in SKIP_FAMILIES:
        return 'skip', f'family {fam}'
    if gen in SKIP_GENERA:
        return 'skip', f'genus {gen}'
    shape = GENUS_SHAPE.get(gen) or FAMILY_SHAPE.get(fam) or 'cup'
    height = GENUS_HEIGHT.get(gen) or FAMILY_HEIGHT.get(fam) or DEFAULT_HEIGHT
    return shape, height


def main():
    cells = load_cells()
    ids = {}
    for cell in cells.values():
        for name, s in cell.items():
            ids[name] = s['id']
    manual = load(TRAITS, {})
    auto = load(AUTO, {})
    taxa = load(TAXA, {})
    photos = load(PHOTOS, {})
    reasons = {}

    def kept(n):
        v = manual.get(n, auto.get(n))
        return v != 'skip'

    for rnd in range(20):
        chosen = round_robin(cells, kept, TOTAL)
        new = [n for n, _ in chosen if n not in manual and n not in auto]
        print(f'round {rnd}: {len(chosen)} chosen, {len(new)} new to describe', flush=True)
        if not new:
            break
        lookup_taxa([ids[n] for n in new], taxa)
        for n in new:
            t = taxa.get(str(ids[n]))
            shape, height = decide(t)
            if shape == 'skip':
                auto[n] = 'skip'
                reasons[n] = height
                continue
            cols = likeness(photo_colours(t['photo'], photos)) if t['photo'] else None
            if not cols:
                cols = list(FAMILY_COLOUR.get(t['family'], DEFAULT_COLOUR))
            petal, centre = cols
            if shape == 'daisy' and centre == petal and t['family'] == 'Asteraceae':
                # Daisies nearly always have a disc that differs a little.
                h, s, v = colorsys.rgb_to_hsv(*[int(petal[i:i + 2], 16) / 255 for i in (1, 3, 5)])
                centre = '#e8c23a' if s < 0.2 or not (35 < h * 360 < 70) else hexc(colorsys.hsv_to_rgb(h * 0.85, min(1, s * 1.1), v * 0.8))
            auto[n] = [petal, centre, shape, height]
        save(AUTO, dict(sorted(auto.items())))

    chosen = round_robin(cells, kept, TOTAL)
    skipped = sorted(n for n, v in auto.items() if v == 'skip')
    print(f'{len(chosen)} kept, {len(skipped)} skipped automatically')
    for n in skipped:
        if n in reasons:
            print(f'  skip {n}: {reasons[n]}')

    if '--sheet' in sys.argv:
        rows = []
        for n, common in chosen:
            v = manual.get(n) if isinstance(manual.get(n), list) else auto[n]
            t = taxa.get(str(ids[n]), {})
            rows.append({'name': n, 'common': common, 'family': t.get('family', ''),
                         'petal': v[0], 'centre': v[1], 'shape': v[2], 'height': v[3],
                         'manual': isinstance(manual.get(n), list)})
        save(SHEET, rows)
        print(f'review sheet data -> {SHEET}; open tools/flowers/sheet.html from a server at the repo root')


if __name__ == '__main__':
    main()
